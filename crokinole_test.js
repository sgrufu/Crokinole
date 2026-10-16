'use strict';

/**
 * Test del motore. `node --test` dalla cartella crokinole/.
 * Scenari costruiti a mano (sono anche la documentazione delle regole) piu'
 * partite a raffica sugli invarianti.
 */

const test = require('node:test');
const assert = require('node:assert');
const C = require('./crokinole');

const G = C.GEOMETRIA;
const R = G.raggioDisco;
const EPS = 1e-6;
// gli scenari sono pensati in pollici (le misure del tavolo vero); il motore lavora in cm
const IN = 2.54;

// ------------------------------------------------------------ aiuti

/** Una Partita con il posto `primo` di turno e dei dischetti gia' sul piano. */
function scenario({ n = 2, primo = 0, dischi = [], fisica = {} } = {}) {
  const nomi = n === 2 ? ['A', 'B'] : ['A1', 'B1', 'A2', 'B2'];
  let s = C.nuovaPartita({ giocatori: nomi, seed: 7, primo, fisica });
  s = { ...s, dischi: dischi.map((d, i) => ({ id: 1000 + i, ...d })) };
  return s;
}

/** Posiziona il dischetto all'angolo relativo `rel` (gradi) dal centro del quarto e tira verso (tx, ty). */
function tiraVerso(s, { rel = 0, tx = 0, ty = 0, forza }) {
  const p = s.turno;
  const centro = C.angoloPosto(s.n, p);
  s = C.posiziona(s, p, centro + rel * Math.PI / 180).stato;
  const angolo = Math.atan2(ty - s.posizione.y, tx - s.posizione.x);
  return C.tira(s, p, { angolo, forza });
}

/** Forza necessaria per fermarsi dopo `dist` cm (senza urti). */
function forzaPer(dist, f = C.FISICA_DEFAULT) {
  return Math.sqrt(2 * f.decelerazione * dist) / f.velocitaMax;
}

/** Un punto in direzione `gradi` (coordinate assolute) a distanza `r` dal centro. */
const polare = (gradi, r) => ({ x: r * Math.cos(gradi * Math.PI / 180), y: r * Math.sin(gradi * Math.PI / 180) });

// Dal posto 0 (sud) il quarto e' centrato a -90°. REL_FRA_I_PIOLI e' l'angolo
// (rispetto al centro del quarto) della retta verso il centro che passa
// esattamente a meta' fra due pioli. Si ricava dalla geometria, cosi' i test
// valgono qualunque sia la disposizione dei pioli (sfasamentoPioli).
const PASSO_PIOLI = 360 / G.numeroPioli;
const REL_FRA_I_PIOLI = (((G.sfasamentoPioli * 180 / Math.PI + PASSO_PIOLI / 2 + 90) % PASSO_PIOLI) + PASSO_PIOLI) % PASSO_PIOLI;

// ------------------------------------------------------------ geometria

test('posti: in 2 sud e nord, in 4 senso orario sud-ovest-nord-est', () => {
  const a = (n, p) => Math.round(C.angoloPosto(n, p) * 180 / Math.PI) + 0; // +0: niente -0
  assert.deepStrictEqual([a(2, 0), a(2, 1)], [-90, 90]);
  assert.deepStrictEqual([0, 1, 2, 3].map(p => a(4, p)), [-90, 180, 90, 0]);
  assert.deepStrictEqual([0, 1, 2, 3].map(C.squadraDi), [0, 1, 0, 1], 'compagni di fronte');
});

test('il posizionamento viene limitato al proprio quarto', () => {
  const pos = C.posizioneSuArco(2, 0, 0); // a est: fuori dal quarto sud
  const gradi = Math.round(pos.phi * 180 / Math.PI);
  assert.strictEqual(gradi, -45, 'si ferma sulla linea divisoria');
  assert.ok(Math.abs(Math.hypot(pos.x, pos.y) - G.raggioEsterno) < EPS, 'sta sulla linea di tiro');
});

test('posiziona: non dove c\'e\' gia\' un dischetto, e solo se tocca a te', () => {
  const sopra = C.posizioneSuArco(2, 0, -Math.PI / 2);
  const s = scenario({ dischi: [{ squadra: 1, x: sopra.x, y: sopra.y + 0.5 * IN }] });
  assert.throws(() => C.posiziona(s, 0, -Math.PI / 2), C.MossaIllegale);
  assert.strictEqual(C.posizioneLibera(s, 0, -Math.PI / 2), false);
  assert.doesNotThrow(() => C.posiziona(s, 0, -Math.PI / 2 + 0.5));
  assert.throws(() => C.posiziona(s, 1, Math.PI / 2), /turno/);
});

test('il dischetto, una volta messo giu\', non si sposta piu\'', () => {
  let s = C.posiziona(scenario(), 0, -Math.PI / 2).stato;
  assert.throws(() => C.posiziona(s, 0, -Math.PI / 2 + 0.3), /già sul tavolo/);
  // dopo il tiro, al turno successivo si posiziona di nuovo
  s = C.tira(s, 0, { angolo: Math.PI / 2, forza: 0.1 }).stato;
  assert.strictEqual(s.posizione, null);
  assert.doesNotThrow(() => C.posiziona(s, 1, Math.PI / 2));
});

test('tira senza aver posizionato e\' una mossa illegale', () => {
  const s = scenario();
  assert.throws(() => C.tira(s, 0, { angolo: Math.PI / 2, forza: 0.5 }), /Prima scegli/);
});

test('zone: sulla linea vale la zona piu\' bassa', () => {
  assert.strictEqual(C.puntiDi({ x: 0, y: 1 * IN }), 15);
  assert.strictEqual(C.puntiDi({ x: 0, y: G.raggio15 - R + 0.01 }), 10, 'tocca la linea del 15');
  assert.strictEqual(C.puntiDi({ x: 0, y: G.raggio15 - R - 0.01 }), 15);
  assert.strictEqual(C.puntiDi({ x: 0, y: G.raggio10 - R + 0.01 }), 5, 'tocca la linea del 10');
  assert.strictEqual(C.puntiDi({ x: 0, y: 9 * IN }), 5);
  assert.ok(C.toccaLineaEsterna({ x: 0, y: G.raggioEsterno - R + 0.01 }));
  assert.ok(!C.toccaLineaEsterna({ x: 0, y: G.raggioEsterno - R - 0.01 }));
  assert.ok(C.raggiungeIl15({ x: 0, y: G.raggio15 + R - 0.01 }), 'toccare la linea del 15 basta per il tiro aperto');
  assert.ok(!C.raggiungeIl15({ x: 0, y: G.raggio15 + R + 0.01 }));
});

// ------------------------------------------------------------ fisica

test('determinismo: stesso stato + stesso tiro = stesso risultato, bit per bit', () => {
  const base = scenario({ dischi: [
    { squadra: 1, ...polare(-80, 6 * IN) }, { squadra: 0, ...polare(-100, 3 * IN) }, { squadra: 1, ...polare(10, 2 * IN) },
  ] });
  const uno = tiraVerso(base, { rel: 5, tx: 0, ty: 0, forza: 0.8 });
  const due = tiraVerso(base, { rel: 5, tx: 0, ty: 0, forza: 0.8 });
  assert.strictEqual(JSON.stringify(uno), JSON.stringify(due));
  assert.ok(uno.stato.ultimoTiro.traiettoria.ids.length >= 2, 'il tiro deve aver urtato qualcosa per essere un test sensato');
});

test('un dischetto tirato piano si ferma dove dice la fisica (attrito costante)', () => {
  const f = C.FISICA_DEFAULT;
  const s = scenario({ dischi: [] });
  const forza = forzaPer(5 * IN);
  const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, forza });
  const d = out.stato.ultimoTiro.traiettoria;
  const ultima = d.foto[d.foto.length - 1][0];
  const percorsi = Math.hypot(ultima[0] - out.stato.ultimoTiro.esito.partenza.x, ultima[1] - out.stato.ultimoTiro.esito.partenza.y);
  assert.ok(Math.abs(percorsi - 5 * IN) < 0.25, `percorsi ${percorsi} cm invece di ${5 * IN}`);
  assert.ok(d.durata > 0 && d.durata < f.tempoMax);
});

test('l\'energia cinetica non aumenta mai', () => {
  const dischi = [
    { id: 1, squadra: 1, ...polare(-85, 6 * IN) }, { id: 2, squadra: 0, ...polare(-95, 5 * IN) },
    { id: 3, squadra: 1, ...polare(-60, 3 * IN) }, { id: 4, squadra: 1, ...polare(170, 5 * IN) },
    { id: 5, squadra: 0, x: 0, y: -G.raggioEsterno },
  ];
  for (const ang of [70, 80, 90, 100, 110]) {
    const v = C.FISICA_DEFAULT.velocitaMax;
    const r = C.simula(dischi, { id: 5, vx: v * Math.cos(ang * Math.PI / 180), vy: v * Math.sin(ang * Math.PI / 180) },
      C.FISICA_DEFAULT, { registraEnergia: true });
    for (let i = 1; i < r.energie.length; i++) {
      assert.ok(r.energie[i] <= r.energie[i - 1] + 1e-9, `energia salita al passo ${i} (angolo ${ang})`);
    }
  }
});

test('un tiro alla velocita\' massima (e oltre) contro un piolo non lo attraversa', () => {
  // per ogni piolo: dalla linea esterna, dritto contro il piolo verso il centro
  for (const piolo of C.PIOLI) {
    const ux = piolo.x / G.raggioPioli, uy = piolo.y / G.raggioPioli;
    for (const molt of [1, 2, 3]) {
      const v = C.FISICA_DEFAULT.velocitaMax * molt;
      const r = C.simula([{ id: 1, squadra: 0, x: ux * G.raggioEsterno, y: uy * G.raggioEsterno }],
        { id: 1, vx: -ux * v, vy: -uy * v }, C.FISICA_DEFAULT);
      for (const f of r.traiettoria.foto) {
        if (!f[0]) continue;
        const lungoLaRetta = f[0][0] * ux + f[0][1] * uy; // distanza dal centro lungo la retta del piolo
        assert.ok(lungoLaRetta > G.raggioPioli, `a ${molt}x il dischetto ha attraversato il piolo (${lungoLaRetta})`);
      }
    }
  }
});

test('a fine tiro nessun dischetto si sovrappone ad altri o ai pioli', () => {
  let x = 99;
  const caso = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  for (let prova = 0; prova < 60; prova++) {
    const dischi = [];
    while (dischi.length < 10) {
      const d = { id: dischi.length + 1, squadra: dischi.length % 2, ...polare(caso() * 360, (0.9 + caso() * 9.5) * IN) };
      const libero = dischi.every(e => Math.hypot(e.x - d.x, e.y - d.y) > 2 * R + 0.01) &&
        C.PIOLI.every(p => Math.hypot(p.x - d.x, p.y - d.y) > R + G.raggioPiolo + 0.01);
      if (libero) dischi.push(d);
    }
    const tiratore = { id: 99, squadra: 0, x: 0, y: -G.raggioEsterno };
    const ang = (60 + caso() * 60) * Math.PI / 180;
    const v = C.FISICA_DEFAULT.velocitaMax * (0.3 + caso() * 0.7);
    const r = C.simula([...dischi, tiratore], { id: 99, vx: v * Math.cos(ang), vy: v * Math.sin(ang) }, C.FISICA_DEFAULT);
    for (let i = 0; i < r.finali.length; i++) {
      for (let j = i + 1; j < r.finali.length; j++) {
        const a = r.finali[i], b = r.finali[j];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * R - 1e-6, `sovrapposizione ${a.id}/${b.id} (prova ${prova})`);
      }
      for (const p of C.PIOLI) {
        const a = r.finali[i];
        assert.ok(Math.hypot(a.x - p.x, a.y - p.y) >= R + G.raggioPiolo - 1e-6, `dischetto ${a.id} dentro un piolo (prova ${prova})`);
      }
    }
  }
});

test('il 20: entra se ci arriva piano, lo salta se ci passa veloce', () => {
  const dist = G.raggioEsterno; // dalla linea di tiro al centro
  const piano = tiraVerso(scenario(), { rel: REL_FRA_I_PIOLI, forza: forzaPer(dist) * 1.005 });
  assert.strictEqual(piano.stato.venti[0], 1, 'piano e preciso: e\' un 20');
  assert.strictEqual(piano.stato.dischi.length, 0, 'il 20 esce dal piano');

  const veloce = tiraVerso(scenario(), { rel: REL_FRA_I_PIOLI, forza: 0.9 });
  assert.strictEqual(veloce.stato.venti[0], 0, 'troppo veloce: salta il buco');
});

test('passare sopra il buco costa velocita\': chi lo attraversa si ferma prima', () => {
  const senzaBuco = { attrazioneBuco: 0, frenataBuco: 0, perditaBordo: 0 };
  // dalla linea di tiro, fra i pioli, dritto sul centro e oltre di 9" (22,86 cm)
  const dir = (-90 + REL_FRA_I_PIOLI) * Math.PI / 180;
  const partenza = { x: G.raggioEsterno * Math.cos(dir), y: G.raggioEsterno * Math.sin(dir) };
  const percorso = fisica => {
    const f = { ...C.FISICA_DEFAULT, ...fisica };
    const v = Math.sqrt(2 * f.decelerazione * (G.raggioEsterno + 9 * IN));
    const r = C.simula([{ id: 1, squadra: 0, ...partenza }], { id: 1, vx: -Math.cos(dir) * v, vy: -Math.sin(dir) * v }, f);
    assert.deepStrictEqual(r.nelBuco, [], 'troppo veloce per cadere');
    return { dist: Math.hypot(r.finali[0].x - partenza.x, r.finali[0].y - partenza.y), suoni: r.traiettoria.suoni };
  };
  const libero = percorso(senzaBuco), conBuco = percorso({});
  assert.ok(Math.abs(libero.dist - (G.raggioEsterno + 9 * IN)) < 0.4, `senza effetti va dove dice l'attrito (${libero.dist})`);
  assert.ok(conBuco.dist < libero.dist - 0.5 * IN, `il buco deve frenare: ${conBuco.dist} contro ${libero.dist}`);
  assert.ok(conBuco.suoni.some(s => s.tipo === 'bordo'), 'si sente il bordo del buco');
});

test('il buco attira: un dischetto lento che passa di lato ci cade dentro', () => {
  // passa a 0,9 cm dal centro: fuori dal raggio di cattura e di ribaltamento,
  // ma col centro sopra il buco. Si cerca una velocita' con cui, senza
  // attrazione, lo sfiora e passa, e con l'attrazione curva e cade.
  const base = { ...C.FISICA_DEFAULT, frenataBuco: 0, perditaBordo: 0 };
  const dischi = [{ id: 1, squadra: 0, x: 0.9, y: -8 }];
  let visto = false;
  for (let vc = 4; vc <= 18 && !visto; vc += 0.5) {
    const tiro = { id: 1, vx: 0, vy: Math.sqrt(vc * vc + 2 * base.decelerazione * 8) };
    const senza = C.simula(dischi, tiro, { ...base, attrazioneBuco: 0 });
    const con = C.simula(dischi, tiro, base);
    if (senza.nelBuco.length === 0 && con.nelBuco.length === 1) visto = true;
  }
  assert.ok(visto, 'esiste una velocita\' a cui solo l\'attrazione lo fa cadere');
});

test('chi si ferma quasi al centro del buco ci cade; sul bordo del buco no', () => {
  const fisica = { ...C.FISICA_DEFAULT, attrazioneBuco: 0, frenataBuco: 0, perditaBordo: 0 };
  const fermaIn = x => C.simula([{ id: 1, squadra: 0, x, y: -5 }],
    { id: 1, vx: 0, vy: Math.sqrt(2 * fisica.decelerazione * 5) }, fisica).nelBuco;
  assert.deepStrictEqual(fermaIn(fisica.raggioRibaltamento * 0.8), [1], 'col centro quasi sul centro: si ribalta dentro');
  assert.deepStrictEqual(fermaIn(1.2), [], 'col centro sul bordo del buco resta fuori');
});

test('il 20 tiene un dischetto solo: dopo il primo il buco e\' pieno, niente ostacolo e niente secondo 20', () => {
  // mischie vicino al centro, tiri verso il centro: si cercano i casi in cui
  // un dischetto cade e DOPO un altro passa sopra il buco
  let x = 4242;
  const caso = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  let cadute = 0, passaggiDopo = 0;
  for (let prova = 0; prova < 300; prova++) {
    const dischi = [];
    while (dischi.length < 8) {
      const d = { id: dischi.length + 1, squadra: dischi.length % 2, ...polare(caso() * 360, (1.2 + caso() * 3.5) * IN) };
      const libero = dischi.every(e => Math.hypot(e.x - d.x, e.y - d.y) > 2 * R + 0.05) &&
        C.PIOLI.every(p => Math.hypot(p.x - d.x, p.y - d.y) > R + G.raggioPiolo + 0.05) &&
        Math.hypot(d.x, d.y) > G.raggioBuco + 0.1;
      if (libero) dischi.push(d);
    }
    const dir = (-90 + REL_FRA_I_PIOLI + (caso() - 0.5) * 8) * Math.PI / 180;
    const tiratore = { id: 99, squadra: 0, x: G.raggioEsterno * Math.cos(dir), y: G.raggioEsterno * Math.sin(dir) };
    const v = C.FISICA_DEFAULT.velocitaMax * (0.45 + caso() * 0.35);
    const ang = Math.atan2(-tiratore.y, -tiratore.x) + (caso() - 0.5) * 0.1;
    const r = C.simula([...dischi, tiratore], { id: 99, vx: v * Math.cos(ang), vy: v * Math.sin(ang) },
      C.FISICA_DEFAULT, { registraContatti: true });
    const tr = r.traiettoria;
    assert.ok(r.nelBuco.length <= 1, `due 20 nello stesso tiro (prova ${prova})`);
    for (const s of tr.suoni.filter(s => s.tipo === 'venti')) {
      cadute++;
      // dopo la caduta, nessun urto con quel dischetto
      // s.t e' arrotondato al millesimo: un urto nello stesso passo, appena
      // prima della caduta, sembrerebbe successivo. Margine = arrotondamento + un passo.
      const margine = 0.0005 + C.FISICA_DEFAULT.dt;
      const urtiDopo = r.contatti.filter(c => c.t > s.t + margine && (c.a === s.id || c.b === s.id));
      assert.deepStrictEqual(urtiDopo, [], `il ${s.id} e' nel buco ma viene ancora urtato (prova ${prova})`);
      // qualcun altro passa dove stava, dopo che e' caduto?
      tr.foto.forEach((f, k) => {
        if (tr.tempi[k] <= s.t) return;
        tr.ids.forEach((id, n) => {
          if (id !== s.id && f[n] && Math.hypot(f[n][0], f[n][1]) < 2 * R) passaggiDopo++;
        });
      });
    }
  }
  assert.ok(cadute >= 5, `servono cadute per un test sensato (${cadute})`);
  assert.ok(passaggiDopo > 0, 'in almeno un caso un altro dischetto passa sopra il buco dopo una caduta');
});

test('buco pieno: chi si ferma esattamente sul buco gia\' occupato non ci cade', () => {
  const fisica = C.FISICA_DEFAULT;
  const d = [{ id: 1, squadra: 0, x: 0, y: -5 }];
  const tiro = { id: 1, vx: 0, vy: Math.sqrt(2 * fisica.decelerazione * 5) }; // si ferma al centro
  assert.deepStrictEqual(C.simula(d, tiro, fisica).nelBuco, [1], 'col buco libero ci cade');
  const pieno = C.simula(d, tiro, fisica, { bucoOccupato: true });
  assert.deepStrictEqual(pieno.nelBuco, [], 'col buco pieno resta sopra');
  assert.ok(Math.hypot(pieno.finali[0].x, pieno.finali[0].y) < 0.1, 'ed e\' fermo proprio sul centro');
});

test('chi esce dalla superficie finisce nel fossato', () => {
  const s = scenario();
  const out = tiraVerso(s, { rel: 0, tx: 0, ty: -50 * IN, forza: 0.6 }); // all'indietro
  assert.strictEqual(out.stato.dischi.length, 0);
  assert.ok(out.stato.ultimoTiro.esito.tolti.length === 1);
});

// ------------------------------------------------------------ regole

test('obbligo di colpire: se manco l\'avversario e\' fallo, e via tutti i miei che si sono mossi', () => {
  const avv = polare(90, 6 * IN);                 // avversario dall'altra parte
  const mio = polare(-90 + REL_FRA_I_PIOLI, 7 * IN); // mio, sulla traiettoria
  const s = scenario({ dischi: [{ squadra: 1, ...avv }, { squadra: 0, ...mio }] });
  // tiro piano verso il mio dischetto: lo sposto un po', l'avversario non lo tocco
  const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, tx: 0, ty: 0, forza: forzaPer(6 * IN) });
  const e = out.stato.ultimoTiro.esito;
  assert.strictEqual(e.valido, false);
  assert.match(e.motivo, /avversario/);
  assert.deepStrictEqual(out.stato.dischi.map(d => d.squadra), [1], 'resta solo l\'avversario');
  assert.strictEqual(e.tolti.length, 2, 'il tiratore e il mio dischetto colpito');
});

test('obbligo di colpire: vale anche il colpo indiretto (il mio spinge il suo)', () => {
  const dir = -90 + REL_FRA_I_PIOLI;
  const s = scenario({ dischi: [
    { squadra: 0, ...polare(dir, 8 * IN) },
    { squadra: 1, ...polare(dir, 8 * IN - 2 * R - 0.3 * IN) },
  ] });
  const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, tx: 0, ty: 0, forza: 0.6 });
  const e = out.stato.ultimoTiro.esito;
  assert.strictEqual(e.valido, true, e.motivo);
  const traiettoria = out.stato.ultimoTiro.traiettoria;
  assert.ok(traiettoria.ids.includes(1001), 'l\'avversario si e\' mosso');
});

test('tiro aperto: valido se il tiratore arriva al 15, fallo se si ferma prima', () => {
  const buono = tiraVerso(scenario(), { rel: REL_FRA_I_PIOLI, forza: forzaPer(G.raggioEsterno - 2.5 * IN) });
  assert.strictEqual(buono.stato.ultimoTiro.esito.valido, true);
  assert.strictEqual(buono.stato.dischi.length, 1);

  const corto = tiraVerso(scenario(), { rel: REL_FRA_I_PIOLI, forza: forzaPer(4 * IN) });
  assert.strictEqual(corto.stato.ultimoTiro.esito.valido, false);
  assert.match(corto.stato.ultimoTiro.esito.motivo, /15/);
  assert.strictEqual(corto.stato.dischi.length, 0);
});

test('tiro aperto (NCA 3a-ii): valido anche se e\' un MIO dischetto colpito a finire nel 15', () => {
  const dir = -90 + REL_FRA_I_PIOLI;
  // il mio dischetto sta appena fuori dal 15; lo colpisco piano: lui entra, io resto nel 10
  const s = scenario({ dischi: [{ squadra: 0, ...polare(dir, G.raggio15 + R + 0.6 * IN) }] });
  const dist = G.raggioEsterno - (G.raggio15 + R + 0.6 * IN) - 2 * R; // fino al contatto
  const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, forza: forzaPer(dist + 1.6 * IN) });
  const e = out.stato.ultimoTiro.esito;
  const tirato = out.stato.dischi.find(d => d.id === e.idTirato);
  const colpito = out.stato.dischi.find(d => d.id === 1000);
  assert.ok(tirato && !C.raggiungeIl15(tirato), 'il tiratore NON e\' arrivato al 15 (scenario sensato)');
  assert.ok(colpito && C.raggiungeIl15(colpito), 'il colpito si', JSON.stringify(colpito));
  assert.strictEqual(e.valido, true);
});

test('un dischetto avversario spinto nel 20 vale per il suo proprietario', () => {
  // avversario quasi al centro, lo spingo piano dentro il buco
  const dir = -90 + REL_FRA_I_PIOLI;
  const s = scenario({ dischi: [{ squadra: 1, ...polare(dir, 2 * R + 0.05 * IN) }] });
  // con urto quasi elastico il mio si ferma e lui prosegue: deve percorrere ~2R+0.05
  let trovato = null;
  for (let k = 0; k < 60 && !trovato; k++) {
    const forza = forzaPer(G.raggioEsterno - 2 * R + (0.1 + k * 0.02) * IN);
    const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, forza });
    if (out.stato.venti[1] === 1) trovato = out;
  }
  assert.ok(trovato, 'esiste una forza che manda l\'avversario nel 20');
  assert.strictEqual(trovato.stato.venti[0], 0);
  assert.strictEqual(trovato.stato.ultimoTiro.esito.valido, true);
});

test('fallo: un 20 fatto con un tiro irregolare non vale', () => {
  // avversario lontano dal centro e fuori traiettoria; io vado dritto nel 20
  const s = scenario({ dischi: [{ squadra: 1, ...polare(150, 9 * IN) }] });
  const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, forza: forzaPer(G.raggioEsterno) * 1.005 });
  assert.strictEqual(out.stato.ultimoTiro.esito.valido, false);
  assert.deepStrictEqual(out.stato.venti, [0, 0]);
});

test('linea esterna: chi la tocca a fine tiro e\' fuori', () => {
  // avversario oltre il centro, sulla stessa retta: lo spingo verso il bordo
  // opposto. Cerco la forza con cui si ferma proprio a cavallo della linea.
  const s = scenario({ dischi: [{ squadra: 1, ...polare(-90 + REL_FRA_I_PIOLI + 180, 9 * IN) }] });
  let trovato = null;
  for (let k = 0; k < 200 && !trovato; k++) {
    const out = tiraVerso(s, { rel: REL_FRA_I_PIOLI, forza: 0.5 + k * 0.002 });
    if (out.stato.ultimoTiro.esito.tolti.some(t => t.id === 1000 && t.motivo === 'linea esterna')) trovato = out;
  }
  assert.ok(trovato, 'esiste una forza che lascia l\'avversario sulla linea esterna');
  assert.strictEqual(trovato.stato.ultimoTiro.esito.valido, true, 'l\'ho colpito: tiro valido');
  for (const d of trovato.stato.dischi) assert.ok(!C.toccaLineaEsterna(d), `il ${d.id} tocca la linea esterna ma e' rimasto`);
  assert.ok(!trovato.stato.dischi.some(d => d.id === 1000), 'l\'avversario e\' stato tolto');
});

test('tempo scaduto: e\' sempre fallo, il dischetto si perde', () => {
  const s = scenario({ dischi: [{ squadra: 1, ...polare(90, 3 * IN) }] });
  const out = C.tiroScaduto(s, 0);
  assert.strictEqual(out.stato.ultimoTiro.esito.valido, false);
  assert.strictEqual(out.stato.ultimoTiro.esito.scaduto, true);
  assert.strictEqual(out.stato.dischi.length, 1, 'resta solo quello avversario');
  assert.strictEqual(out.stato.daTirare[0], 11);
  assert.strictEqual(out.stato.turno, 1);
});

test('turni in 4: senso orario, 6 dischetti a testa, chi apre ruota a ogni round', () => {
  let s = C.nuovaPartita({ giocatori: ['A1', 'B1', 'A2', 'B2'], seed: 3, primo: 2 });
  assert.deepStrictEqual(s.daTirare, [6, 6, 6, 6]);
  const ordine = [];
  while (s.fase === 'tiro') { ordine.push(s.turno); s = C.tiroScaduto(s, s.turno).stato; }
  assert.deepStrictEqual(ordine.slice(0, 5), [2, 3, 0, 1, 2]);
  assert.strictEqual(ordine.length, 24);
  assert.strictEqual(s.fase, 'fineRound');
  s = C.continua(s).stato;
  assert.strictEqual(s.round, 2);
  assert.strictEqual(s.turno, 3, 'il round dopo apre il successivo in senso orario');
});

test('punteggio a cancellazione: segna solo chi ha di piu\', la differenza', () => {
  const dischi = [
    { squadra: 0, x: 0, y: 1 * IN },   // 15
    { squadra: 0, x: 0, y: 9 * IN },   // 5
    { squadra: 1, x: 6 * IN, y: 0 },   // 10
  ];
  const c = C.contaRound(dischi, [1, 0]); // + un 20 per la squadra 0
  assert.strictEqual(c.dettaglio[0].totale, 40);
  assert.strictEqual(c.dettaglio[1].totale, 10);
  assert.strictEqual(c.segna, 0);
  assert.strictEqual(c.delta, 30);
  assert.strictEqual(C.contaRound([], [0, 0]).segna, null, 'pareggio: non segna nessuno');
});

test('fine Partita: chi arriva a 100 vince, senza passare dal "continua"', () => {
  let s = C.nuovaPartita({ giocatori: ['A', 'B'], seed: 1, primo: 0 });
  s = { ...s, punteggi: [90, 0], daTirare: [0, 1], turno: 1, dischi: [{ id: 500, squadra: 0, x: 0, y: 1 * IN }] };
  const out = C.tiroScaduto(s, 1);
  assert.strictEqual(out.stato.fase, 'finita');
  assert.strictEqual(out.stato.vincitore, 0);
  assert.deepStrictEqual(out.stato.punteggi, [105, 0]);
  assert.ok(out.eventi.some(e => e.tipo === 'partita_finita'));
  assert.throws(() => C.continua(out.stato), C.MossaIllegale);
});

test('imprecisione: a 0 il tiro e\' esatto, accesa cambia il risultato in modo riproducibile', () => {
  const tiro = f => tiraVerso(scenario({ fisica: f }), { rel: REL_FRA_I_PIOLI, forza: 0.5 }).stato.ultimoTiro.traiettoria.foto.at(-1);
  assert.deepStrictEqual(tiro({}), tiro({}));
  const rumoroso = { rumoreAngolo: 0.05, rumoreForza: 0.1 };
  assert.notDeepStrictEqual(tiro({}), tiro(rumoroso));
  assert.deepStrictEqual(tiro(rumoroso), tiro(rumoroso), 'il rumore viene dal seed: riproducibile');
});

// ------------------------------------------------------------ vista

/**
 * Congela i campi della vista. Se ne aggiungi uno questo test si rompe e ti
 * costringe a chiederti se e' roba che un Giocatore (o uno spettatore) puo'
 * sapere. E' stato rotto apposta una volta, aggiungendo `rng` alla vista.
 */
const CAMPI_ATTESI = ['io', 'n', 'nomi', 'fase', 'round', 'punteggi', 'puntiVittoria', 'apreIlRound',
  'turno', 'daTirare', 'dischi', 'venti', 'posizione', 'ultimoTiro', 'riepilogo', 'storicoRound', 'vincitore'];

test('statoVisibile espone esattamente i campi previsti, in ogni fase', () => {
  let s = C.nuovaPartita({ giocatori: ['A', 'B'], seed: 2 });
  const controlla = (st, cosa) => {
    for (const posto of [0, 1, null]) {
      assert.deepStrictEqual(Object.keys(C.statoVisibile(st, posto)).sort(), [...CAMPI_ATTESI].sort(), cosa);
    }
  };
  controlla(s, 'inizio');
  while (s.fase === 'tiro') s = C.tiroScaduto(s, s.turno).stato;
  controlla(s, 'fine round');
  const v = C.statoVisibile(s, 0);
  assert.strictEqual(v.rng, undefined, 'lo stato del generatore resta nel server');
  assert.strictEqual(v.seed, undefined);
});

// ------------------------------------------------------------ a raffica

test('partite a raffica (2 e 4): conservazione dei dischetti, punteggi coerenti, fine garantita', () => {
  let x = 12345;
  const caso = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  for (let partita = 0; partita < 40; partita++) {
    const n = partita % 2 ? 4 : 2;
    let s = C.nuovaPartita({ giocatori: n === 2 ? ['A', 'B'] : ['a', 'b', 'c', 'd'], seed: partita + 1, fisica: { puntiVittoria: 60 } });
    let fuoriRound = 0, ventiRound = 0, tiri = 0;
    let giri = 0;
    while (s.fase !== 'finita') {
      assert.ok(++giri < 5000, 'la Partita deve finire');
      if (s.fase === 'fineRound') {
        // ogni dischetto tirato e' in gioco, nel 20 o tolto
        const inGioco = s.dischi.length;
        assert.strictEqual(inGioco + ventiRound + fuoriRound, 24, `conservazione (partita ${partita}, round ${s.round})`);
        s = C.continua(s).stato; fuoriRound = 0; ventiRound = 0;
        continue;
      }
      const p = s.turno;
      const centro = C.angoloPosto(n, p);
      let phi = centro + (caso() - 0.5) * 1.5;
      if (!C.posizioneLibera(s, p, phi)) phi = centro;
      if (!C.posizioneLibera(s, p, phi)) { s = C.tiroScaduto(s, p).stato; tiri++; fuoriRound++; continue; }
      s = C.posiziona(s, p, phi).stato;
      const verso = Math.atan2(-s.posizione.y, -s.posizione.x) + (caso() - 0.5) * 0.4;
      const out = C.tira(s, p, { angolo: verso, forza: 0.3 + caso() * 0.7 });
      const e = out.stato.ultimoTiro.esito;
      fuoriRound += e.tolti.length;
      ventiRound += e.ventiFatti.length;
      tiri++;
      s = out.stato;
      for (let i = 0; i < s.dischi.length; i++) {
        assert.ok(!C.toccaLineaEsterna(s.dischi[i]), 'nessuno resta sulla linea esterna');
      }
    }
    // la somma dei delta e' il punteggio finale
    const somma = [0, 1].map(sq => s.storicoRound.filter(r => r.segna === sq).reduce((a, r) => a + r.delta, 0));
    assert.deepStrictEqual(somma, s.punteggi);
    assert.ok(s.punteggi[s.vincitore] >= 60);
    assert.ok(tiri > 0);
  }
});
