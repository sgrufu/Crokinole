'use strict';

/**
 * PROVA END-TO-END: client Node che parla lo stesso protocollo del browser
 * (/entra, SSE su /eventi, POST per le azioni) contro il server VERO.
 *
 * Uso (dalla cartella crokinole/, con il server gia' acceso):
 *   ANIMAZIONE_FATTORE=0 PUNTI_VITTORIA=30 PORTA=4700 node server.js &
 *   node public/prova-e2e.js 4700 2 partita
 *   node public/prova-e2e.js 4700 4 partita
 *   node public/prova-e2e.js 4700 2 rientro
 * e con TEMPO_TIRO_MS=300 sul server:
 *   node public/prova-e2e.js 4700 2 tempo
 *
 * Serve il pacchetto `eventsource` (npm install --no-save eventsource): e'
 * un named export, `const { EventSource } = require('eventsource')`.
 */

const assert = require('node:assert');
const { EventSource } = require('eventsource');
const C = require('../crokinole');

const PORTA = Number(process.argv[2]) || 4700;
const N = Number(process.argv[3]) || 2;
const SCENARIO = process.argv[4] || 'partita';
const BASE = `http://localhost:${PORTA}`;

let x = Number(process.env.SEME) || 1;
const caso = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };

async function posta(percorso, dati) {
  const r = await fetch(BASE + percorso, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dati || {}),
  });
  return { status: r.status, dati: await r.json().catch(() => ({})) };
}

/** Un utente: entra, ascolta, tiene l'ultimo pacchetto. */
async function utente(nome) {
  const r = await posta('/entra', { nome });
  assert.strictEqual(r.status, 200, `entra ${nome}: ${JSON.stringify(r.dati)}`);
  const u = { nome, token: r.dati.token, pk: null, es: null };
  u.collega = () => new Promise(risolvi => {
    u.es = new EventSource(`${BASE}/eventi?token=${u.token}`);
    u.es.onmessage = ev => { u.pk = JSON.parse(ev.data); risolvi(); };
  });
  u.azione = (percorso, dati) => posta(percorso, { ...dati, token: u.token });
  await u.collega();
  return u;
}

async function aspetta(cond, cosa, ms = 8000) {
  const fine = Date.now() + ms;
  while (Date.now() < fine) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('Tempo scaduto aspettando: ' + cosa);
}

/** Il giocatore di turno posiziona (riprovando se il punto e' occupato) e tira. */
async function giocaUnTiro(u) {
  const pk = u.pk;
  const posto = pk.io.posto;
  const centro = C.angoloPosto(pk.n, posto);
  let ok = false;
  for (let tentativo = 0; tentativo < 20 && !ok; tentativo++) {
    const phi = centro + (caso() - 0.5) * 1.5;
    const r = await u.azione('/posiziona', { phi });
    ok = r.status === 200;
    if (!ok) assert.strictEqual(r.status, 400, JSON.stringify(r.dati));
  }
  assert.ok(ok, 'riesco a mettere il dischetto da qualche parte');
  await aspetta(() => u.pk.posizione && u.pk.posizione.posto === posto, 'posizione visibile');
  const pos = u.pk.posizione;
  const angolo = Math.atan2(-pos.y, -pos.x) + (caso() - 0.5) * 0.5;
  const prima = u.pk.numeroTiro;
  const r = await u.azione('/tira', { angolo, forza: 0.3 + caso() * 0.6 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.dati));
  await aspetta(() => u.pk.numeroTiro === prima + 1, 'il tiro arriva a tutti');
}

async function siediTutti(giocatori) {
  const slots = N === 2 ? [0, 1] : [0, 1, 2, 3];
  for (let i = 0; i < giocatori.length; i++) {
    const r = await giocatori[i].azione('/siedi', { slot: slots[i] });
    assert.strictEqual(r.status, 200);
  }
  await aspetta(() => giocatori.every(g => g.pk.slot && g.pk.slot.filter(Boolean).length === N), 'tutti seduti');
}

// ------------------------------------------------------------------ scenari

async function partita() {
  const giocatori = [];
  for (let i = 0; i < N; i++) giocatori.push(await utente('G' + i));
  const spettatore = await utente('Spettatore');

  // un posto occupato non si prende: si chiede lo scambio
  await siediTutti(giocatori);
  assert.strictEqual(giocatori[0].pk.puoAvviare, true, 'si puo\' avviare');
  const occupato = await spettatore.azione('/siedi', { slot: 0 });
  assert.strictEqual(occupato.status, 409, 'uno spettatore non scavalca chi e\' seduto');
  await giocatori[0].azione('/siedi', { slot: 1 });
  await aspetta(() => giocatori[1].pk.richiestaPerMe, 'la richiesta di scambio arriva');
  await giocatori[1].azione('/rispondi', { accetta: true });
  await aspetta(() => giocatori[0].pk.io.slot === 1 && giocatori[1].pk.io.slot === 0, 'scambio fatto');
  await giocatori[0].azione('/siedi', { slot: 0 });
  await aspetta(() => giocatori[1].pk.richiestaPerMe, 'seconda richiesta');
  await giocatori[1].azione('/rispondi', { accetta: true });
  await aspetta(() => giocatori[0].pk.io.slot === 0, 'scambiati di nuovo');

  await spettatore.azione('/chat', { testo: 'forza Rossi' });
  await aspetta(() => giocatori[0].pk.chat.some(m => m.testo === 'forza Rossi'), 'chat dello spettatore');

  // il tempo per tiro si sceglie in sala; lo spettatore non puo'
  assert.strictEqual((await spettatore.azione('/tempo', { secondi: 0 })).status, 409);
  assert.strictEqual((await giocatori[0].azione('/tempo', { secondi: 7 })).status, 400, 'solo i valori previsti');
  await giocatori[1].azione('/tempo', { secondi: 0 });
  await aspetta(() => giocatori[0].pk.tempoTiroMs === 0, 'nessun limite di tempo');

  const avvio = await giocatori[0].azione('/avvia');
  assert.strictEqual(avvio.status, 200, JSON.stringify(avvio.dati));
  await aspetta(() => giocatori.every(g => g.pk.fase === 'tiro'), 'Partita iniziata');
  assert.strictEqual(spettatore.pk.io.spettatore, true);

  await aspetta(() => giocatori[0].pk.tempo.modo === 'corre', 'si puo\' tirare');
  assert.strictEqual(giocatori[0].pk.tempo.msAllaScadenza, null, 'senza limite non c\'e\' orologio');
  const furbo = await spettatore.azione('/tira', { angolo: 0, forza: 1 });
  assert.strictEqual(furbo.status, 403, 'lo spettatore non tira');

  let partiteFinite = 0;
  let tiri = 0;
  for (let giro = 0; giro < 20000; giro++) {
    const pk = giocatori[0].pk;
    if (pk.fase === 'attesa') break;
    if (pk.fase === 'tiro') {
      const diTurno = giocatori.find(g => g.pk.io.posto === pk.turno);
      // fuori turno non si tira
      const altro = giocatori.find(g => g !== diTurno);
      if (tiri === 0) {
        const r = await altro.azione('/posiziona', { phi: 0 });
        assert.strictEqual(r.status, 400, 'fuori turno: mossa illegale');
      }
      await aspetta(() => diTurno.pk.tempo.modo === 'corre', 'timer partito');
      await giocaUnTiro(diTurno);
      tiri++;
      continue;
    }
    if (pk.fase === 'fineRound') {
      const round = pk.round;
      for (const g of giocatori) await g.azione('/continua');
      await aspetta(() => giocatori[0].pk.round === round + 1 || giocatori[0].pk.fase !== 'fineRound', 'round nuovo');
      continue;
    }
    if (pk.fase === 'finita') {
      partiteFinite++;
      const [a, b] = pk.punteggi;
      assert.ok(Math.max(a, b) >= pk.puntiVittoria, 'chi vince ha raggiunto la soglia');
      assert.strictEqual(spettatore.pk.vincitore, pk.vincitore, 'lo spettatore vede lo stesso risultato');
      if (partiteFinite === 1) {
        for (const g of giocatori) await g.azione('/ancora', { si: true });
        await aspetta(() => giocatori[0].pk.fase === 'tiro' && giocatori[0].pk.round === 1 &&
          giocatori[0].pk.punteggi.every(p => p === 0), 'rivincita');
      } else {
        await giocatori[0].azione('/ancora', { si: false });
        for (const g of giocatori.slice(1)) await g.azione('/ancora', { si: true });
        await aspetta(() => giocatori[0].pk.fase === 'attesa', 'di nuovo in sala');
      }
      continue;
    }
  }
  assert.strictEqual(partiteFinite, 2, 'giocate due Partite (la seconda e\' la rivincita)');
  const sala = giocatori[1].pk;
  assert.strictEqual(giocatori[0].pk.io.slot, null, 'chi ha detto no e\' diventato spettatore');
  assert.strictEqual(sala.slot.filter(Boolean).length, N - 1, 'gli altri sono rimasti seduti');
  console.log(`  partita in ${N}: ${tiri} tiri, 2 Partite, rivincita e ritorno in sala: OK`);
  for (const u of [...giocatori, spettatore]) u.es.close();
}

async function rientro() {
  const a = await utente('Anna'), b = await utente('Bruno');
  await a.azione('/siedi', { slot: 0 }); await b.azione('/siedi', { slot: 1 });
  await aspetta(() => a.pk.puoAvviare, 'seduti');
  await a.azione('/avvia');
  await aspetta(() => a.pk.fase === 'tiro' && a.pk.tempo.modo === 'corre', 'Partita iniziata');
  const diTurno = a.pk.turno === a.pk.io.posto ? a : b;
  const altro = diTurno === a ? b : a;

  // chi e' di turno si scollega: il tempo si ferma
  diTurno.es.close();
  await aspetta(() => altro.pk.tempo.modo === 'sospeso', 'timer sospeso');
  assert.strictEqual(altro.pk.connessi[diTurno === a ? 0 : 1], false);

  // un altro con lo stesso nome mentre lui e' connesso: rifiutato
  const doppio = await posta('/entra', { nome: altro.nome.toUpperCase() });
  assert.strictEqual(doppio.status, 409, 'nome gia\' connesso: rifiutato');

  // rientro per nome: stesso posto, token nuovo, si chiede "sei pronto?"
  const r = await posta('/entra', { nome: diTurno.nome });
  assert.strictEqual(r.status, 200);
  const vecchioPosto = altro.pk.turno;
  diTurno.token = r.dati.token;
  await diTurno.collega();
  await aspetta(() => diTurno.pk.tempo.modo === 'pronto', 'richiesta di conferma');
  assert.strictEqual(diTurno.pk.io.posto, vecchioPosto, 'stesso posto di prima');
  await diTurno.azione('/pronto');
  await aspetta(() => diTurno.pk.tempo.modo === 'corre', 'il tempo riparte');
  assert.ok(diTurno.pk.tempo.msAllaScadenza > diTurno.pk.tempoTiroMs - 1000, 'riparte da capo');

  // tutti escono; il primo che rientra puo' eliminare la Partita
  a.es.close(); b.es.close();
  await new Promise(res => setTimeout(res, 100));
  const r2 = await posta('/entra', { nome: 'Bruno' });
  b.token = r2.dati.token;
  await b.collega();
  await aspetta(() => b.pk.puoiEliminare === true, 'offerta di eliminazione');
  await b.azione('/elimina');
  await aspetta(() => b.pk.fase === 'attesa', 'tornati in sala');
  assert.ok(!b.pk.slot.some(s => s && s.nome === 'Anna'), 'Anna, scollegata, non resta come fantasma');
  console.log('  rientro, timer sospeso, "sei pronto?", eliminazione: OK');
  b.es.close();
  await posta('/ricomincia');

  // voto di chiusura in 2
  const c = await utente('Carla'), d = await utente('Dario');
  await c.azione('/siedi', { slot: 2 }); await d.azione('/siedi', { slot: 3 });
  await aspetta(() => c.pk.puoAvviare, 'seduti');
  await d.azione('/avvia');
  await aspetta(() => c.pk.fase === 'tiro', 'via');
  await c.azione('/vota', { si: true });
  await aspetta(() => d.pk.voti.quanti === 1, 'voto visibile');
  assert.strictEqual(d.pk.fase, 'tiro', 'un voto solo non basta');
  await d.azione('/vota', { si: true });
  await aspetta(() => c.pk.fase === 'attesa', 'chiusa a voto');
  console.log('  voto di chiusura: OK');
  c.es.close(); d.es.close();
}

async function tempo() {
  const a = await utente('Ugo'), b = await utente('Vera');
  await a.azione('/siedi', { slot: 0 }); await b.azione('/siedi', { slot: 1 });
  await aspetta(() => a.pk.puoAvviare, 'seduti');
  await a.azione('/avvia');
  await aspetta(() => a.pk.fase === 'tiro', 'via');
  // nessuno tira: allo scadere il dischetto si perde e il turno passa
  await aspetta(() => a.pk.numeroTiro >= 2, 'due tiri scaduti', 5000);
  const e = a.pk.ultimoTiro.esito;
  assert.strictEqual(e.scaduto, true);
  assert.strictEqual(e.valido, false);
  assert.strictEqual(a.pk.dischi.length, 0, 'i dischetti scaduti sono persi');
  console.log('  tempo scaduto = fallo automatico: OK');
  a.es.close(); b.es.close();
}

(async () => {
  await posta('/ricomincia');
  if (SCENARIO === 'partita') await partita();
  else if (SCENARIO === 'rientro') await rientro();
  else if (SCENARIO === 'tempo') await tempo();
  else throw new Error('scenario sconosciuto: ' + SCENARIO);
  process.exit(0);
})().catch(e => { console.error('FALLITO:', e); process.exit(1); });
