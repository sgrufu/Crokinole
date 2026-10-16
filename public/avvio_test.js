'use strict';

/**
 * AVVIO DELLA PAGINA: carica index.html in un DOM finto (jsdom) e controlla
 * che lo script arrivi in fondo senza errori e che tutte le funzioni chiamate
 * dai bottoni esistano. Serve contro la trappola della `const`/`let` usata
 * prima della sua riga: la pagina si carica, ma nessun bottone risponde.
 *
 * jsdom non disegna il canvas: getContext viene sostituito da un contesto
 * finto che accetta qualunque chiamata. Poi si fanno arrivare pacchetti
 * costruiti col motore vero (sala, partita, fine round, fine Partita) per
 * passare da tutti i rami del disegno.
 *
 * Serve jsdom: npm install --no-save jsdom
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const C = require('../crokinole');

const qui = __dirname;
const motore = fs.readFileSync(path.join(qui, '..', 'crokinole.js'), 'utf8');
const tavolo = fs.readFileSync(path.join(qui, 'tavolo.js'), 'utf8');

function contestoFinto() {
  const gradiente = { addColorStop() {} };
  return new Proxy({}, {
    get(_, k) {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => gradiente;
      return typeof k === 'string' ? () => {} : undefined;
    },
    set() { return true; },
  });
}

function carica() {
  let html = fs.readFileSync(path.join(qui, 'index.html'), 'utf8');
  html = html
    .replace('<script src="crokinole.js"></script>', `<script>${motore}</script>`)
    .replace('<script src="tavolo.js"></script>', `<script>${tavolo}</script>`);
  const errori = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost:3004/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => contestoFinto();
      w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
      w.EventSource = class { close() {} };
      w.addEventListener('error', e => errori.push(e.message || String(e.error)));
    },
  });
  dom.virtualConsole?.on?.('jsdomError', e => errori.push(e.message));
  return { dom, w: dom.window, errori };
}

const attendi = ms => new Promise(r => setTimeout(r, ms));

function pacchettoSala() {
  return {
    io: { nome: 'Anna', slot: 0, posto: -1, spettatore: false },
    chat: [{ nome: 'Anna', testo: 'e\' entrata', ts: 1, sistema: true }, { nome: 'Bea', testo: 'ciao <b>', ts: 2 }],
    log: [], versione: 1, spettatori: [{ nome: 'Ciro', connesso: true }], tempoTiroMs: 15000,
    fase: 'attesa',
    slot: [{ nome: 'Anna', connesso: true, io: true }, { nome: 'Bea', connesso: true, io: false }, null, null],
    puoAvviare: true, richiestaPerMe: null, richiestaMia: null, opzioniTempo: [10, 15, 20, 30, 45, 60, 0],
    puntiVittoria: 100, opzioniPunti: [50, 75, 100, 150, 200],
  };
}

function pacchettoPartita(stato, posto, extra = {}) {
  return {
    ...C.statoVisibile(stato, posto >= 0 ? posto : null),
    io: { nome: 'Anna', slot: 0, posto, spettatore: posto < 0 },
    chat: [], log: ['— Partita 1'], versione: 2, spettatori: [], tempoTiroMs: 15000,
    connessi: stato.nomi.map(() => true),
    numeroTiro: stato.tiriNelRound,
    tempo: { msAlloSblocco: 0, modo: 'corre', msAllaScadenza: 9000 },
    continuaPremuto: stato.nomi.map(() => false),
    ancoraRisposte: stato.nomi.map(() => null),
    voti: { quanti: 0, servono: 2, ioSi: false },
    puoiEliminare: false,
    ...extra,
  };
}

test('la pagina si carica senza errori e mostra l\'ingresso', async t => {
  const { w, errori } = carica();
  t.after(() => w.close()); // senza, requestAnimationFrame tiene vivo il processo
  await attendi(50);
  assert.deepStrictEqual(errori, []);
  for (const fn of ['entra', 'collegati', 'ricevi', 'render', 'posta', 'tira', 'posizionaDischetto',
    'avvisa', 'renderSala', 'renderPartita', 'renderFinestra', 'fotogramma', 'esci']) {
    assert.strictEqual(typeof w[fn], 'function', `manca la funzione ${fn}`);
  }
  assert.ok(!w.document.getElementById('ingresso').classList.contains('nascosto'), 'l\'ingresso e\' visibile');
  assert.ok(w.Crokinole && w.Tavolo, 'motore e disegno caricati');
});

test('sala d\'attesa, partita, fine round e fine Partita si disegnano senza errori', async t => {
  const { w, errori } = carica();
  t.after(() => w.close());
  await attendi(30);
  const d = w.document;
  w.eval('collegati = function(){}'); // niente rete vera
  d.getElementById('app').classList.remove('nascosto');

  w.ricevi(pacchettoSala());
  assert.ok(!d.getElementById('sala').classList.contains('nascosto'));
  assert.strictEqual(d.querySelectorAll('.posto').length, 4, 'quattro posti in due colonne');
  assert.ok(d.getElementById('chat').innerHTML.includes('&lt;b&gt;'), 'la chat e\' escapata');
  assert.strictEqual(d.getElementById('bottoneAvvia').disabled, false);
  assert.strictEqual(d.getElementById('tempoTiro').value, '15', 'tempo di tiro scelto in sala');
  assert.ok([...d.querySelectorAll('#tempoTiro option')].some(o => o.textContent === 'Nessun limite'));

  // partita in 4, tocca a me (posto 0): tavolo visibile
  let s = C.nuovaPartita({ giocatori: ['Anna', 'Bea', 'Ciro', 'Dino'], seed: 3, primo: 0 });
  w.ricevi(pacchettoPartita(s, 0));
  assert.ok(d.getElementById('sala').classList.contains('nascosto'));
  assert.ok(!d.getElementById('zonaTavolo').classList.contains('nascosto'));
  assert.strictEqual(d.querySelectorAll('#rimasti .riga').length, 4);
  assert.strictEqual(d.getElementById('venti0').textContent, '× 0', 'si vedono i 20 del round');

  // un tiro vero: il client deve animarlo
  s = C.posiziona(s, 0, -Math.PI / 2 + 0.3).stato;
  w.ricevi(pacchettoPartita(s, 0));
  const out = C.tira(s, 0, { angolo: Math.PI / 2 - 0.2, forza: 0.6 });
  w.ricevi(pacchettoPartita(out.stato, 0, { numeroTiro: 1 }));
  await attendi(80); // qualche fotogramma
  assert.ok(w.eval('animazione !== null || moviolaDi !== null'), 'il tiro viene riprodotto');

  // fine round: compare il riepilogo con "Continua"
  let fr = out.stato;
  while (fr.fase === 'tiro') fr = C.tiroScaduto(fr, fr.turno).stato;
  w.eval('animazione = null');
  w.ricevi(pacchettoPartita(fr, 0, { numeroTiro: 1 }));
  assert.ok(!d.getElementById('velo').classList.contains('nascosto'), 'finestra di fine round');
  assert.ok(d.getElementById('finestra').textContent.includes('Fine del round'));
  assert.ok(d.getElementById('fContinua'));

  // fine Partita
  const fin = { ...fr, fase: 'finita', vincitore: 1, punteggi: [20, 100] };
  w.ricevi(pacchettoPartita(fin, 0, { numeroTiro: 1 }));
  assert.ok(d.getElementById('finestra').textContent.includes('Vincono i Blu'));
  assert.ok(d.getElementById('fSi') && d.getElementById('fNo'), 'vuoi giocare ancora?');

  // spettatore: niente bottoni di gioco, si puo' ruotare
  w.ricevi(pacchettoPartita(C.nuovaPartita({ giocatori: ['A', 'B'], seed: 1 }), -1));
  assert.ok(!d.getElementById('bottoneRuota').classList.contains('nascosto'));
  assert.ok(d.getElementById('bottoneVoto').classList.contains('nascosto'));

  await attendi(50);
  assert.deepStrictEqual(errori, []);
});
