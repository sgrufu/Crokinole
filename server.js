'use strict';

/**
 * SERVER DEL CROKINOLE — stessa tecnica di Indovina chi (vedi
 * ARCHITETTURA-GIOCHI.md): ZERO DIPENDENZE, SSE per spingere lo stato, POST
 * per le intenzioni. Il client non decide mai niente.
 *
 * DIFFERENZE rispetto a Indovina chi:
 *   - niente salvataggio su disco (scelta esplicita): se il server si
 *     riavvia la Partita e' persa. Il rientro per nome vive in memoria.
 *   - SALA D'ATTESA A DUE COLONNE: 4 posti (0 e 2 squadra A, 1 e 3 squadra
 *     B). Ci si sposta su un posto libero, o si chiede lo scambio a chi
 *     occupa un posto. Si parte in 2 (uno per colonna) o in 4.
 *   - SPETTATORI: chiunque entri senza sedersi. Vedono tutto (nel crokinole
 *     non c'e' niente di nascosto) e scrivono in chat, ma non votano.
 *   - IL TEMPO: dopo ogni tiro il server aspetta la durata della traiettoria
 *     (+ un margine) prima di accettare il tiro successivo: cosi' tutti hanno
 *     visto dove sono finiti i dischetti. Nessuna conferma dai client (una
 *     scheda in secondo piano bloccherebbe tutti). Poi parte il timer di tiro.
 *   - se tocca a un Giocatore scollegato il timer si ferma; quando rientra
 *     gli si chiede "sei pronto?" e il timer riparte da capo.
 *
 * Specifiche complete: CROKINOLE.md.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const C    = require('./crokinole');

// Render (e simili) assegnano la porta in PORT
const PORTA = process.env.PORT || process.env.PORTA || 3004;
// indirizzo pubblico su Render: serve per il segnale contro lo spegnimento
const INDIRIZZO_PUBBLICO = process.env.RENDER_EXTERNAL_URL || '';
const SVEGLIA_MS = 10 * 60 * 1000;
// tempo per tirare: si sceglie in sala d'attesa (0 = nessun limite)
const OPZIONI_TEMPO_S = [10, 15, 20, 30, 45, 60, 0];
const TEMPO_TIRO_DEFAULT_MS = Number(process.env.TEMPO_TIRO_MS) || 15000;
const MARGINE_ANIMAZIONE_MS = 700;
// 0 nei test end-to-end: niente attese per le animazioni
const FATTORE_ANIMAZIONE = process.env.ANIMAZIONE_FATTORE != null ? Number(process.env.ANIMAZIONE_FATTORE) : 1;
const GRAZIA_MS = Number(process.env.GRAZIA_MS) || 8000;
const FISICA = process.env.PUNTI_VITTORIA ? { puntiVittoria: Number(process.env.PUNTI_VITTORIA) } : {};

const colonnaDi = slot => slot % 2;          // 0 = squadra A (Rossi), 1 = squadra B (Blu)
const NOMI_SQUADRE = ['Rossi', 'Blu'];
const CON_ARTICOLO = ['i Rossi', 'i Blu'];

// ------------------------------------------------------------------ tavolo

let tavolo = tavoloVuoto();

function tavoloVuoto() {
  return {
    persone: [],             // [{token, nome, slot}]  slot 0..3 in sala d'attesa, null = spettatore
    ascoltatori: new Map(),  // token -> response SSE
    chat: [],                // [{nome, testo, ts, sistema}]
    log: [],                 // cronaca della Partita
    versione: 0,
    richieste: [],           // [{da, a}] richieste di scambio posto
    tempoTiroMs: TEMPO_TIRO_DEFAULT_MS, // scelto in sala d'attesa; 0 = nessun limite
    partita: null,
    partiteGiocate: 0,
  };
}

/**
 * partita = {
 *   stato,         stato del motore
 *   posti,         token per posto del motore (2 o 4)
 *   sbloccoA,      ms: prima di questo istante non si tira (animazione)
 *   timer,         {modo: 'attesa'|'corre'|'sospeso'|'pronto', scadenza}
 *   continua,      Set di token che hanno premuto "Continua"
 *   ancora,        Map token -> bool ("vuoi giocare ancora?")
 *   voti,          Set di token che vogliono chiudere la Partita
 *   tuttiUsciti,   true quando l'ultimo Giocatore si e' scollegato
 *   offerta,       token di chi, rientrando per primo, puo' eliminarla
 *   numeroTiro,    contatore globale dei tiri (il client anima quando cambia)
 *   tempoTiroMs,   tempo per tirare, fissato all'avvio (0 = nessun limite)
 * }
 */

const token = () => Math.random().toString(36).slice(2, 10);
const cerca = t => tavolo.persone.find(p => p.token === t);
const connesso = t => tavolo.ascoltatori.has(t);
const seduti = () => tavolo.persone.filter(p => p.slot !== null);
const postoDi = t => tavolo.partita ? tavolo.partita.posti.indexOf(t) : -1;
const giocatoriConnessi = () => tavolo.partita ? tavolo.partita.posti.filter(connesso) : [];

function annota(testo) {
  tavolo.log.push(testo);
  if (tavolo.log.length > 80) tavolo.log.shift();
}

function scriviInChat(nome, testo, sistema = false) {
  tavolo.chat.push({ nome, testo, ts: Date.now(), sistema });
  if (tavolo.chat.length > 200) tavolo.chat.shift();
}

const timersGrazia = new Map(); // token -> Timeout
function annullaGrazia(t) {
  const x = timersGrazia.get(t);
  if (x) { clearTimeout(x); timersGrazia.delete(t); }
}

// ------------------------------------------------------------ sala d'attesa

function puoAvviare() {
  const s = seduti();
  if (s.length === 4) return true;
  if (s.length === 2) return colonnaDi(s[0].slot) !== colonnaDi(s[1].slot);
  return false;
}

function avviaPartita() {
  const s = seduti();
  // in 4: posti del motore in senso orario A1, B1, A2, B2 = slot 0, 1, 2, 3
  // in 2: posto 0 = colonna A, posto 1 = colonna B
  const posti = s.length === 4
    ? [0, 1, 2, 3].map(slot => s.find(p => p.slot === slot).token)
    : [s.find(p => colonnaDi(p.slot) === 0).token, s.find(p => colonnaDi(p.slot) === 1).token];
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const nomi = posti.map(t => cerca(t).nome);
  const stato = C.nuovaPartita({ giocatori: nomi, seed, fisica: FISICA });
  tavolo.richieste = [];
  tavolo.partiteGiocate++;
  tavolo.partita = {
    stato, posti, sbloccoA: Date.now(),
    timer: { modo: 'attesa', scadenza: null },
    continua: new Set(), ancora: new Map(), voti: new Set(),
    tuttiUsciti: false, offerta: null, numeroTiro: 0,
    tempoTiroMs: tavolo.tempoTiroMs,
  };
  const squadre = [0, 1].map(sq => posti.filter((_, i) => C.squadraDi(i) === sq).map(t => cerca(t).nome).join(' e '));
  annota(`— Partita ${tavolo.partiteGiocate}: ${squadre[0]} (Rossi) contro ${squadre[1]} (Blu). [seed ${seed}]`);
  annota(`Il sorteggio fa aprire ${nomi[stato.turno]}. ${descriviTempo(tavolo.tempoTiroMs)}.`);
}

function descriviTempo(ms) {
  return ms ? `Tempo per tirare: ${Math.round(ms / 1000)} secondi` : 'Tempo per tirare: nessun limite';
}

/** Si torna in sala d'attesa. Chi non e' connesso viene tolto (niente fantasmi). */
function tornaInSala(motivo) {
  annota(motivo);
  const p = tavolo.partita;
  tavolo.partita = null;
  clearTimeout(timerTiro);
  if (p) {
    for (const t of p.posti) {
      if (!connesso(t)) tavolo.persone = tavolo.persone.filter(x => x.token !== t);
    }
  }
  // gli spettatori scollegati non hanno timer di grazia attivo se se ne sono andati a Partita in corso
  tavolo.persone = tavolo.persone.filter(x => connesso(x.token) || timersGrazia.has(x.token));
}

// ------------------------------------------------------------------ il tempo

let timerTiro = null;

/**
 * Unico punto che decide lo stato del timer di tiro. Si richiama dopo ogni
 * cosa che puo' cambiarlo: un tiro, un round nuovo, una connessione o una
 * disconnessione, un "sono pronto", lo scadere del tempo.
 */
function valutaTimer() {
  clearTimeout(timerTiro);
  timerTiro = null;
  const p = tavolo.partita;
  if (!p || p.stato.fase !== 'tiro') return;
  const adesso = Date.now();
  if (adesso < p.sbloccoA) {
    p.timer = { modo: 'attesa', scadenza: null };
    timerTiro = setTimeout(() => { valutaTimer(); aggiornaTutti(); }, p.sbloccoA - adesso);
    return;
  }
  const t = p.posti[p.stato.turno];
  const senzaLimite = !p.tempoTiroMs;
  if (!connesso(t)) { p.timer = { modo: 'sospeso', scadenza: null }; return; }
  if (p.timer.modo === 'sospeso') {
    // senza limite di tempo non c'e' nessun orologio da far ripartire:
    // il "sei pronto?" non serve
    p.timer = senzaLimite ? { modo: 'corre', scadenza: null } : { modo: 'pronto', scadenza: null };
    return;
  }
  if (p.timer.modo === 'pronto') return;
  if (p.timer.modo !== 'corre') p.timer = { modo: 'corre', scadenza: senzaLimite ? null : adesso + p.tempoTiroMs };
  if (!senzaLimite) timerTiro = setTimeout(tempoScaduto, Math.max(0, p.timer.scadenza - adesso));
}

function tempoScaduto() {
  const p = tavolo.partita;
  if (!p || p.stato.fase !== 'tiro' || p.timer.modo !== 'corre' || p.timer.scadenza === null) return;
  if (Date.now() < p.timer.scadenza) { valutaTimer(); return; }
  const posto = p.stato.turno;
  annota(`${p.stato.nomi[posto]}: tempo scaduto, il dischetto è perso.`);
  applicaTiro(C.tiroScaduto(p.stato, posto));
  aggiornaTutti();
}

/** Il risultato di un tiro (normale o scaduto) entra nella Partita. */
function applicaTiro(out) {
  const p = tavolo.partita;
  p.stato = out.stato;
  p.numeroTiro++;
  for (const e of out.eventi) raccontaEvento(e);
  const durata = out.stato.ultimoTiro.traiettoria.durata;
  p.sbloccoA = Date.now() + FATTORE_ANIMAZIONE * (durata * 1000 + MARGINE_ANIMAZIONE_MS);
  p.timer = { modo: 'attesa', scadenza: null };
  p.continua = new Set();
  p.ancora = new Map();
  valutaTimer();
}

function raccontaEvento(e) {
  const p = tavolo.partita;
  const nomi = p.stato.nomi;
  if (e.tipo === 'tiro') {
    const x = e.esito;
    if (x.scaduto) return;
    const parti = [];
    if (!x.valido) parti.push(`fallo (${x.motivo})`);
    if (x.ventiFatti.length) parti.push(x.ventiFatti.map(v => `20 per ${CON_ARTICOLO[v.squadra]}`).join(', '));
    const fuori = x.valido ? x.tolti.length : 0;
    if (fuori) parti.push(`${fuori} fuori`);
    annota(`${nomi[x.posto]} tira${parti.length ? ': ' + parti.join(', ') : ''}.`);
  }
  if (e.tipo === 'round_finito') {
    const r = e.riepilogo;
    annota(`Fine round ${r.round}: Rossi ${r.dettaglio[0].totale}, Blu ${r.dettaglio[1].totale}` +
      (r.segna === null ? ' — pari, nessuno segna.' : ` — ${NOMI_SQUADRE[r.segna]} +${r.delta}.`));
  }
  if (e.tipo === 'partita_finita') {
    annota(`— Vincono ${CON_ARTICOLO[e.vincitore]}, ${e.punteggi[e.vincitore]} a ${e.punteggi[1 - e.vincitore]}! —`);
  }
}

// ------------------------------------------------------- decisioni collettive

/** "Continua", "ancora?" e voto: contano i Giocatori connessi, almeno uno. */
function controllaDecisioni() {
  const p = tavolo.partita;
  if (!p) return;
  const vivi = giocatoriConnessi();
  if (!vivi.length) return;

  if (p.stato.fase === 'fineRound' && vivi.every(t => p.continua.has(t))) {
    const out = C.continua(p.stato);
    p.stato = out.stato;
    p.continua = new Set();
    p.sbloccoA = Date.now();
    p.timer = { modo: 'attesa', scadenza: null };
    annota(`Round ${p.stato.round}: apre ${p.stato.nomi[p.stato.turno]}.`);
    valutaTimer();
    return;
  }

  if (p.stato.fase === 'finita' && vivi.every(t => p.ancora.has(t))) {
    const tutti = vivi.every(t => p.ancora.get(t)) && p.posti.every(connesso);
    if (tutti) {
      annota('Tutti vogliono la rivincita.');
      avviaPartita();
      valutaTimer();
    } else {
      // chi ha detto no diventa spettatore, chi ha detto si resta seduto
      for (const t of vivi) if (!p.ancora.get(t)) { const x = cerca(t); if (x) x.slot = null; }
      tornaInSala('Fine della Partita: si torna in sala d\'attesa.');
    }
    return;
  }

  if (p.voti.size && vivi.every(t => p.voti.has(t))) {
    tornaInSala('Partita chiusa a voto.');
  }
}

// ---------------------------------------------------------- cosa vede uno

function pacchetto(persona) {
  const p = tavolo.partita;
  const io = {
    nome: persona.nome,
    slot: persona.slot,
    posto: p ? postoDi(persona.token) : -1,
  };
  io.spettatore = p ? io.posto < 0 : persona.slot === null;

  const base = {
    io,
    chat: tavolo.chat,
    log: tavolo.log,
    versione: tavolo.versione,
    spettatori: tavolo.persone.filter(x => (p ? postoDi(x.token) < 0 : x.slot === null)).map(x => ({ nome: x.nome, connesso: connesso(x.token) })),
    tempoTiroMs: p ? p.tempoTiroMs : tavolo.tempoTiroMs,
  };

  if (!p) {
    const slot = [0, 1, 2, 3].map(s => {
      const x = tavolo.persone.find(q => q.slot === s);
      return x ? { nome: x.nome, connesso: connesso(x.token), io: x.token === persona.token } : null;
    });
    const perMe = tavolo.richieste.find(r => r.a === persona.token);
    const mia = tavolo.richieste.find(r => r.da === persona.token);
    return {
      ...base,
      fase: 'attesa',
      slot,
      puoAvviare: puoAvviare() && persona.slot !== null,
      opzioniTempo: OPZIONI_TEMPO_S,
      richiestaPerMe: perMe ? { da: cerca(perMe.da)?.nome, slot: cerca(perMe.da)?.slot } : null,
      richiestaMia: mia ? { a: cerca(mia.a)?.nome } : null,
    };
  }

  const adesso = Date.now();
  const vivi = giocatoriConnessi();
  const altriVivi = vivi.filter(t => t !== persona.token);
  // statoVisibile ha un suo campo `io` (il posto): va PRIMA di base, che
  // porta l'`io` completo (nome, slot, posto, spettatore)
  return {
    ...C.statoVisibile(p.stato, io.posto >= 0 ? io.posto : null),
    ...base,
    connessi: p.posti.map(connesso),
    numeroTiro: p.numeroTiro,
    tempo: {
      msAlloSblocco: Math.max(0, p.sbloccoA - adesso),
      modo: p.timer.modo,
      msAllaScadenza: p.timer.modo === 'corre' && p.timer.scadenza !== null ? Math.max(0, p.timer.scadenza - adesso) : null,
    },
    continuaPremuto: p.posti.map(t => p.continua.has(t)),
    ancoraRisposte: p.posti.map(t => (p.ancora.has(t) ? p.ancora.get(t) : null)),
    voti: { quanti: p.voti.size, servono: vivi.length, ioSi: p.voti.has(persona.token) },
    puoiEliminare: p.offerta === persona.token && altriVivi.length === 0,
  };
}

function aggiornaTutti() {
  tavolo.versione++;
  for (const x of tavolo.persone) {
    const res = tavolo.ascoltatori.get(x.token);
    if (res) res.write(`data: ${JSON.stringify(pacchetto(x))}\n\n`);
  }
}

// ------------------------------------------------------- connessioni

function quandoSiCollega(persona) {
  annullaGrazia(persona.token);
  const p = tavolo.partita;
  if (p && postoDi(persona.token) >= 0) {
    if (p.tuttiUsciti) { p.tuttiUsciti = false; p.offerta = persona.token; }
    valutaTimer();
  }
}

function quandoSiScollega(persona) {
  const p = tavolo.partita;
  if (p && postoDi(persona.token) >= 0) {
    // Giocatore a Partita in corso: il posto resta suo finche' non rientra
    if (!giocatoriConnessi().length) p.tuttiUsciti = true;
    valutaTimer();
    controllaDecisioni();
    aggiornaTutti();
    return;
  }
  // in sala d'attesa, o spettatore: dopo la grazia se ne va
  const timer = setTimeout(() => {
    timersGrazia.delete(persona.token);
    if (connesso(persona.token) || !cerca(persona.token)) return;
    if (tavolo.partita && postoDi(persona.token) >= 0) return;
    tavolo.persone = tavolo.persone.filter(x => x.token !== persona.token);
    tavolo.richieste = tavolo.richieste.filter(r => r.da !== persona.token && r.a !== persona.token);
    aggiornaTutti();
  }, GRAZIA_MS);
  timersGrazia.set(persona.token, timer);
  aggiornaTutti();
}

// -------------------------------------------------------------- il server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
};
const BINARIO = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);

function corpo(req) {
  return new Promise((risolvi, rifiuta) => {
    let dati = '';
    req.on('data', x => {
      dati += x;
      if (dati.length > 1e5) { rifiuta(new Error('richiesta troppo grande')); req.destroy(); }
    });
    req.on('end', () => { try { risolvi(JSON.parse(dati || '{}')); } catch (e) { rifiuta(e); } });
  });
}

const json = (res, codice, dati) => {
  res.writeHead(codice, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(dati));
};

/** Le rotte POST che richiedono di essere qualcuno al tavolo. */
const AZIONI = {
  // ---------------- chat (tutti, sempre)
  chat(persona, dati) {
    const testo = String(dati.testo || '').trim().slice(0, 300);
    if (!testo) return [400, { errore: 'messaggio vuoto' }];
    scriviInChat(persona.nome, testo);
  },

  // ---------------- sala d'attesa
  siedi(persona, dati) {
    if (tavolo.partita) return [409, { errore: 'Partita in corso' }];
    const slot = Number(dati.slot);
    if (![0, 1, 2, 3].includes(slot)) return [400, { errore: 'posto inesistente' }];
    if (persona.slot === slot) return;
    const occupante = tavolo.persone.find(x => x.slot === slot);
    if (!occupante) {
      persona.slot = slot;
      tavolo.richieste = tavolo.richieste.filter(r => r.da !== persona.token && r.a !== persona.token);
      return;
    }
    if (persona.slot === null) return [409, { errore: 'Posto occupato: siediti su uno libero' }];
    tavolo.richieste = tavolo.richieste.filter(r => r.da !== persona.token);
    tavolo.richieste.push({ da: persona.token, a: occupante.token });
  },
  rispondi(persona, dati) {
    const r = tavolo.richieste.find(x => x.a === persona.token);
    if (!r) return [409, { errore: 'nessuna richiesta' }];
    tavolo.richieste = tavolo.richieste.filter(x => x !== r);
    const altro = cerca(r.da);
    if (dati.accetta && altro && altro.slot !== null && persona.slot !== null && !tavolo.partita) {
      [altro.slot, persona.slot] = [persona.slot, altro.slot];
      tavolo.richieste = tavolo.richieste.filter(x => x.da !== persona.token && x.a !== altro.token);
    }
  },
  tempo(persona, dati) {
    if (tavolo.partita) return [409, { errore: 'Il tempo si sceglie prima di iniziare' }];
    if (persona.slot === null) return [409, { errore: 'Solo chi è seduto sceglie il tempo' }];
    const secondi = Number(dati.secondi);
    if (!OPZIONI_TEMPO_S.includes(secondi)) return [400, { errore: 'Tempo non previsto' }];
    if (secondi * 1000 === tavolo.tempoTiroMs) return;
    tavolo.tempoTiroMs = secondi * 1000;
    scriviInChat(persona.nome, secondi ? `imposta ${secondi} secondi per tiro` : 'toglie il limite di tempo', true);
  },
  annullaRichiesta(persona) {
    tavolo.richieste = tavolo.richieste.filter(r => r.da !== persona.token);
  },
  alzati(persona) {
    if (tavolo.partita) return [409, { errore: 'Partita in corso' }];
    persona.slot = null;
    tavolo.richieste = tavolo.richieste.filter(r => r.da !== persona.token && r.a !== persona.token);
  },
  avvia(persona) {
    if (tavolo.partita) return [409, { errore: 'Partita già in corso' }];
    if (persona.slot === null) return [409, { errore: 'Solo chi è seduto può avviare' }];
    if (!puoAvviare()) return [409, { errore: 'Si parte in 2 (uno per colonna) o in 4' }];
    avviaPartita();
    valutaTimer();
  },

  // ---------------- in Partita (solo Giocatori)
  posiziona(persona, dati, posto) {
    const p = tavolo.partita;
    if (Date.now() < p.sbloccoA) return [409, { errore: 'Aspetta che i dischetti si fermino' }];
    p.stato = C.posiziona(p.stato, posto, Number(dati.phi)).stato;
    if (p.timer.modo === 'pronto') { p.timer = { modo: 'attesa', scadenza: null }; valutaTimer(); }
  },
  tira(persona, dati, posto) {
    const p = tavolo.partita;
    if (Date.now() < p.sbloccoA) return [409, { errore: 'Aspetta che i dischetti si fermino' }];
    applicaTiro(C.tira(p.stato, posto, { angolo: Number(dati.angolo), forza: Number(dati.forza) }));
  },
  pronto(persona, dati, posto) {
    const p = tavolo.partita;
    if (p.stato.turno !== posto || p.timer.modo !== 'pronto') return;
    p.timer = { modo: 'attesa', scadenza: null };
    valutaTimer();
  },
  continua(persona) {
    if (tavolo.partita.stato.fase !== 'fineRound') return [409, { errore: 'Il round non è finito' }];
    tavolo.partita.continua.add(persona.token);
    controllaDecisioni();
  },
  ancora(persona, dati) {
    if (tavolo.partita.stato.fase !== 'finita') return [409, { errore: 'La Partita non è finita' }];
    tavolo.partita.ancora.set(persona.token, !!dati.si);
    controllaDecisioni();
  },
  vota(persona, dati) {
    const p = tavolo.partita;
    if (dati.si) p.voti.add(persona.token); else p.voti.delete(persona.token);
    if (dati.si && p.voti.size === 1) annota(`${persona.nome} propone di chiudere la Partita.`);
    controllaDecisioni();
  },
  elimina(persona) {
    const p = tavolo.partita;
    const altri = giocatoriConnessi().filter(t => t !== persona.token);
    if (p.offerta !== persona.token || altri.length) return [409, { errore: 'Non puoi eliminarla adesso' }];
    tornaInSala(`${persona.nome} elimina la Partita.`);
  },
};
const SOLO_IN_PARTITA = new Set(['posiziona', 'tira', 'pronto', 'continua', 'ancora', 'vota', 'elimina']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // --- il motore sta nella cartella principale (lo usano i test Node),
    // ma serve anche al browser: banco di prova e geometria del disegno
    if (req.method === 'GET' && url.pathname === '/crokinole.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fs.readFileSync(path.join(__dirname, 'crokinole.js')));
    }

    // --- pagina e file statici ---
    if (req.method === 'GET' && !url.pathname.startsWith('/eventi') && url.pathname !== '/chi-sono') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const radice = path.join(__dirname, 'public');
      const file = path.resolve(radice, rel);
      if (file.startsWith(radice) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const est = path.extname(file).toLowerCase();
        const testa = { 'Content-Type': MIME[est] || 'application/octet-stream' };
        if (BINARIO.has(est) || est === '.svg') testa['Cache-Control'] = 'max-age=3600';
        res.writeHead(200, testa);
        return res.end(fs.readFileSync(file));
      }
    }

    // --- verificare un token salvato dal client (refresh della scheda) ---
    if (req.method === 'GET' && url.pathname === '/chi-sono') {
      const x = cerca(url.searchParams.get('token'));
      if (!x) return json(res, 401, { errore: 'token sconosciuto' });
      return json(res, 200, { nome: x.nome });
    }

    // --- entrare: come spettatore, oppure rientro per nome ---
    if (req.method === 'POST' && url.pathname === '/entra') {
      const { nome } = await corpo(req);
      const pulito = String(nome || '').trim().slice(0, 16);
      if (!pulito) return json(res, 400, { errore: 'Scegli un nome' });
      const esistente = tavolo.persone.find(x => x.nome.toLowerCase() === pulito.toLowerCase());
      if (esistente) {
        if (connesso(esistente.token)) {
          return json(res, 409, { errore: `"${esistente.nome}" è già connesso da un'altra parte in questo momento` });
        }
        const vecchio = esistente.token;
        esistente.token = token();
        annullaGrazia(vecchio);
        if (tavolo.partita) {
          const i = tavolo.partita.posti.indexOf(vecchio);
          if (i >= 0) tavolo.partita.posti[i] = esistente.token;
          for (const insieme of ['continua', 'voti']) {
            if (tavolo.partita[insieme].delete(vecchio)) tavolo.partita[insieme].add(esistente.token);
          }
          if (tavolo.partita.ancora.has(vecchio)) {
            tavolo.partita.ancora.set(esistente.token, tavolo.partita.ancora.get(vecchio));
            tavolo.partita.ancora.delete(vecchio);
          }
        }
        for (const r of tavolo.richieste) { if (r.da === vecchio) r.da = esistente.token; if (r.a === vecchio) r.a = esistente.token; }
        scriviInChat(esistente.nome, 'rientra', true);
        aggiornaTutti();
        return json(res, 200, { token: esistente.token });
      }
      const x = { token: token(), nome: pulito, slot: null };
      tavolo.persone.push(x);
      scriviInChat(x.nome, tavolo.partita ? 'entra come spettatore' : 'entra', true);
      aggiornaTutti();
      return json(res, 200, { token: x.token });
    }

    // --- il flusso di aggiornamenti (SSE) ---
    if (req.method === 'GET' && url.pathname === '/eventi') {
      const x = cerca(url.searchParams.get('token'));
      if (!x) return json(res, 401, { errore: 'token sconosciuto' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': collegato\n\n');
      const precedente = tavolo.ascoltatori.get(x.token);
      if (precedente && precedente !== res) { try { precedente.end(); } catch (e) {} }
      tavolo.ascoltatori.set(x.token, res);
      quandoSiCollega(x);
      aggiornaTutti();

      const battito = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(battito);
        if (tavolo.ascoltatori.get(x.token) !== res) return; // sostituito da una connessione piu' nuova
        tavolo.ascoltatori.delete(x.token);
        const ancora = tavolo.persone.find(q => q === x);
        if (ancora) quandoSiScollega(x);
      });
      return;
    }

    // --- tutte le azioni ---
    if (req.method === 'POST' && AZIONI[url.pathname.slice(1)]) {
      const nomeAzione = url.pathname.slice(1);
      const dati = await corpo(req);
      const persona = cerca(dati.token);
      if (!persona) return json(res, 401, { errore: 'token sconosciuto' });
      let posto = -1;
      if (SOLO_IN_PARTITA.has(nomeAzione)) {
        if (!tavolo.partita) return json(res, 409, { errore: 'Nessuna Partita in corso' });
        posto = postoDi(persona.token);
        if (posto < 0) return json(res, 403, { errore: 'Gli spettatori guardano e basta' });
      }
      let esito;
      try {
        esito = AZIONI[nomeAzione](persona, dati, posto);
      } catch (e) {
        if (e instanceof C.MossaIllegale) return json(res, 400, { errore: e.message });
        throw e;
      }
      if (esito) return json(res, esito[0], esito[1]);
      aggiornaTutti();
      return json(res, 200, { ok: true });
    }

    // --- segnale contro lo spegnimento (vedi server.listen) ---
    if (req.method === 'GET' && url.pathname === '/sveglia') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
    }

    // --- ricominciare da capo, tavolo vuoto (manutenzione) ---
    if (req.method === 'POST' && url.pathname === '/ricomincia') {
      for (const r of tavolo.ascoltatori.values()) { try { r.end(); } catch (e) {} }
      clearTimeout(timerTiro);
      for (const t of timersGrazia.values()) clearTimeout(t);
      timersGrazia.clear();
      tavolo = tavoloVuoto();
      return json(res, 200, { ok: true });
    }

    res.writeHead(404); res.end('non trovato');
  } catch (e) {
    json(res, 500, { errore: e.message });
  }
});

server.listen(PORTA, () => {
  console.log(`\n  Crokinole in ascolto su http://localhost:${PORTA}`);
  console.log('  Ci si siede in 2 (uno per colonna) o in 4, poi qualcuno avvia.');
  console.log(`  Banco di prova della fisica: http://localhost:${PORTA}/banco.html`);
  console.log('  Per fermarlo: Ctrl+C\n');
  for (const [nome, info] of Object.entries(require('os').networkInterfaces())) {
    for (const i of info || []) {
      if (i.family === 'IPv4' && !i.internal) {
        console.log(`  Dagli altri PC in rete: http://${i.address}:${PORTA}  (${nome})`);
      }
    }
  }
  console.log('');

  // Sul piano gratuito Render spegne il servizio dopo ~15 minuti senza
  // traffico in arrivo: ogni 10 minuti il server chiama se stesso passando
  // dall'indirizzo pubblico, cosi' resta sveglio. In locale non fa niente.
  if (INDIRIZZO_PUBBLICO) {
    console.log(`  Indirizzo pubblico: ${INDIRIZZO_PUBBLICO} (sveglia ogni ${SVEGLIA_MS / 60000} minuti)`);
    setInterval(() => {
      require('https').get(INDIRIZZO_PUBBLICO + '/sveglia', r => r.resume())
        .on('error', e => console.log('  sveglia fallita:', e.message));
    }, SVEGLIA_MS).unref();
  }
});

module.exports = { server };
