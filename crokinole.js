/**
 * CROKINOLE — motore di gioco.
 *
 * Da 2 o 4 Giocatori (in 4 a coppie, compagni di fronte). Fisica dei
 * dischetti simulata qui dentro, in modo deterministico: stesso stato +
 * stesso tiro = stesso risultato, sempre. Il server e' l'unico che chiama
 * `tira`; i client ricevono la traiettoria registrata e la riproducono.
 *
 * Nessuna dipendenza, nessun I/O, nessuna variabile globale mutabile.
 * UMD: gira identico in Node (require) e nel browser (window.Crokinole),
 * dove lo usa il banco di prova e il client per la geometria del disegno.
 *
 * UNITA': centimetri e secondi (le misure ufficiali sono in pollici: 1" = 2,54 cm).
 * Origine al centro del tavolo, asse y in su.
 * I posti girano in senso ORARIO visto dall'alto: posto 0 a sud, poi ovest,
 * nord, est. In 2 i posti sono 0 (sud) e 1 (nord).
 *
 * Specifiche: vedi CROKINOLE.md nel progetto.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.Crokinole = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ geometria

  /**
   * Misure del tavolo in centimetri, convertite esattamente dalle specifiche
   * costruttive comuni, che sono in pollici (fra parentesi l'originale).
   */
  const GEOMETRIA = Object.freeze({
    raggioSuperficie: 33.02,   // superficie di gioco Ø 66,04 cm (26"): oltre c'e' il fossato
    raggioEsterno: 30.48,      // linea esterna = linea di tiro, Ø 60,96 cm (24")
    raggio10: 20.32,           // Ø 40,64 cm (16")
    raggio15: 10.16,           // Ø 20,32 cm (8"), linea dei pioli
    raggioBuco: 1.74625,       // Ø 3,49 cm (1 3/8")
    raggioPiolo: 0.47625,      // Ø 0,95 cm (3/8")
    raggioPioli: 10.16,        // i pioli stanno sulla linea del 15
    numeroPioli: 8,
    // pioli sfalsati di 22,5°: davanti al centro di ogni quarto c'e' un varco
    // fra due pioli, e anche le linee dei quarti puntano in un varco
    sfasamentoPioli: Math.PI / 8,
    raggioDisco: 1.5875,       // Ø 3,175 cm (1 1/4")
    semiAmpiezzaQuarto: Math.PI / 4, // ogni quarto e' largo 90°
  });

  /**
   * Parametri fisici. TUTTI qui, in un posto solo: si tarano col banco di
   * prova (public/banco.html) e si possono passare a nuovaPartita per
   * sovrascriverli. Stanno dentro lo stato, cosi' una Partita e' sempre
   * riproducibile anche se i default cambiano in futuro.
   */
  const FISICA_DEFAULT = Object.freeze({
    decelerazione: 50,         // cm/s² — attrito di scivolamento costante
    velocitaMax: 140,          // cm/s a forza 1
    restituzioneDischi: 0.9,   // urti fra dischetti (1 = perfettamente elastici)
    restituzionePioli: 0.6,    // urti contro i pioli
    sogliaBuco: 18,            // cm/s: piu' veloce di cosi' il dischetto "salta" il buco
    raggioCattura: 0.75,       // cm: distanza max centro-dischetto/centro-buco per cadere
    raggioRibaltamento: 0.6,   // cm: chi si FERMA col centro entro questa distanza dal centro del buco ci cade
    // Il buco non e' un punto: quando il centro del dischetto e' sopra il
    // buco il dischetto non e' piu' appoggiato e si inclina verso l'interno.
    // Tre effetti, tutti a 0 = spenti:
    attrazioneBuco: 60,        // cm/s²: spinta laterale verso il centro (curva di piu' chi va piano)
    frenataBuco: 20,           // cm/s²: attrito in piu' mentre si e' sopra il buco
    perditaBordo: 0.12,        // frazione di velocita' persa uscendo (il bordo opposto del buco)
    velocitaArresto: 0.75,     // cm/s: sotto, il dischetto si ferma
    dt: 1 / 600,               // passo di simulazione (s)
    tempoMax: 25,              // s: oltre, tutto si ferma comunque
    fotogrammiAlSecondo: 30,   // frequenza della traiettoria registrata
    rumoreAngolo: 0,           // radianti: imprecisione casuale massima sull'angolo (0 = spenta)
    rumoreForza: 0,            // frazione: imprecisione casuale massima sulla forza (0 = spenta)
    puntiVittoria: 100,
  });

  const DISCHI_PER_SQUADRA = 12;

  // ------------------------------------------------------------ errori

  class MossaIllegale extends Error {
    constructor(msg) { super(msg); this.name = 'MossaIllegale'; }
  }
  const check = (cond, msg) => { if (!cond) throw new MossaIllegale(msg); };

  // ------------------------------------------------------------ casualita'

  /** mulberry32: un intero a 32 bit di stato, dentro lo stato di gioco. */
  function prossimoCasuale(seme) {
    let t = (seme + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return { valore: ((r ^ (r >>> 14)) >>> 0) / 4294967296, seme: t };
  }

  // ------------------------------------------------------------ posti e quarti

  /** Angolo (radianti) del centro del quarto del posto `p`, con `n` Giocatori. */
  function angoloPosto(n, p) {
    const passo = n === 2 ? Math.PI : Math.PI / 2;
    return normalizzaAngolo(-Math.PI / 2 - passo * p);
  }

  const squadraDi = p => p % 2;

  function normalizzaAngolo(a) {
    const due = 2 * Math.PI;
    a = a % due;
    if (a <= -Math.PI) a += due;
    if (a > Math.PI) a -= due;
    return a;
  }

  /** Posizione dei pioli, calcolata una volta. */
  const PIOLI = Object.freeze(Array.from({ length: GEOMETRIA.numeroPioli }, (_, k) => {
    const a = GEOMETRIA.sfasamentoPioli + k * 2 * Math.PI / GEOMETRIA.numeroPioli;
    return Object.freeze({ x: GEOMETRIA.raggioPioli * Math.cos(a), y: GEOMETRIA.raggioPioli * Math.sin(a) });
  }));

  /**
   * Il punto della linea di tiro in cui finisce il dischetto se il Giocatore
   * clicca all'angolo `phi`. L'angolo viene limitato al proprio quarto (il
   * centro del dischetto puo' stare sulla linea divisoria: tocca entrambe).
   */
  function posizioneSuArco(n, posto, phi) {
    const centro = angoloPosto(n, posto);
    let rel = normalizzaAngolo(phi - centro);
    const lim = GEOMETRIA.semiAmpiezzaQuarto;
    if (rel > lim) rel = lim;
    if (rel < -lim) rel = -lim;
    const a = centro + rel;
    return { phi: normalizzaAngolo(a), x: GEOMETRIA.raggioEsterno * Math.cos(a), y: GEOMETRIA.raggioEsterno * Math.sin(a) };
  }

  // ------------------------------------------------------------ zone

  const raggioDi = d => Math.sqrt(d.x * d.x + d.y * d.y);

  /** Tocca o supera la linea esterna -> fuori (regola NCA 8e). */
  function toccaLineaEsterna(d) {
    return raggioDi(d) + GEOMETRIA.raggioDisco >= GEOMETRIA.raggioEsterno;
  }

  /** Dentro il 15 o ne tocca la linea (vale per la validita' del tiro aperto). */
  function raggiungeIl15(d) {
    return raggioDi(d) - GEOMETRIA.raggioDisco <= GEOMETRIA.raggio15;
  }

  /** Punti di un dischetto in gioco: sulla linea vale la zona piu' bassa. */
  function puntiDi(d) {
    const bordo = raggioDi(d) + GEOMETRIA.raggioDisco;
    if (bordo < GEOMETRIA.raggio15) return 15;
    if (bordo < GEOMETRIA.raggio10) return 10;
    if (bordo < GEOMETRIA.raggioEsterno) return 5;
    return 0;
  }

  // ------------------------------------------------------------ fisica

  /**
   * Simula un tiro. Pura: non tocca gli argomenti.
   *
   * @param dischi   [{id, squadra, x, y}] in gioco, compreso il tiratore
   * @param tiro     {id, vx, vy}
   * @param p        parametri fisici
   * @returns {
   *   finali:   [{id, squadra, x, y}]  ancora sul piano a fine simulazione
   *   nelBuco:  [id]                  caduti nel 20
   *   nelFossato: [id]                usciti dalla superficie
   *   mossi:    [id]                  si sono mossi (tiratore compreso se aveva velocita')
   *   traiettoria: {fps, durata, ids, foto, suoni}
   *   energie: [..]                   energia cinetica a ogni passo (solo se chiesto, per i test)
   * }
   */
  function simula(dischi, tiro, p, opzioni = {}) {
    const g = GEOMETRIA;
    const R = g.raggioDisco;
    const DIAM = 2 * R;
    const RP = R + g.raggioPiolo;

    const corpi = dischi.map(d => ({ id: d.id, squadra: d.squadra, x: d.x, y: d.y, vx: 0, vy: 0, vivo: true, sopraBuco: false }));
    const tiratore = corpi.find(c => c.id === tiro.id);
    tiratore.vx = tiro.vx; tiratore.vy = tiro.vy;

    const mossi = new Set();
    if (tiro.vx !== 0 || tiro.vy !== 0) mossi.add(tiro.id);
    const nelBuco = [];
    const nelFossato = [];
    const suoni = [];
    const energie = opzioni.registraEnergia ? [] : null;
    const contatti = opzioni.registraContatti ? [] : null; // solo per i test: {t, a, b}

    const passiPerFoto = Math.max(1, Math.round(1 / (p.dt * p.fotogrammiAlSecondo)));
    const istantanee = [];   // [{t, pos: Map id -> [x,y]}]
    const fotografa = t => {
      const pos = new Map();
      for (const c of corpi) {
        if (c.vivo) pos.set(c.id, [c.x, c.y]);
        else if (c.nelBuco) pos.set(c.id, [0, 0]); // resta nel buco fino alla fine del tiro
      }
      istantanee.push({ t, pos });
    };

    let t = 0;
    let passo = 0;
    // Il buco tiene un dischetto solo: dopo il primo 20 e' pieno (a filo del
    // piano) per il resto del tiro. Niente secondo 20 nello stesso tiro, e
    // niente piu' avvallamento: chi ci passa sopra scorre come sul legno.
    let bucoOccupato = !!opzioni.bucoOccupato; // per i test: si puo' partire col buco gia' pieno
    fotografa(0);

    const inMoto = () => corpi.some(c => c.vivo && (c.vx !== 0 || c.vy !== 0));
    const dv = p.decelerazione * p.dt;

    while (inMoto() && t < p.tempoMax) {
      // 1. attrito + spostamento
      for (const c of corpi) {
        if (!c.vivo || (c.vx === 0 && c.vy === 0)) continue;
        const v = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
        if (v <= dv) { c.vx = 0; c.vy = 0; continue; }
        const k = (v - dv) / v;
        c.vx *= k; c.vy *= k;
        c.x += c.vx * p.dt;
        c.y += c.vy * p.dt;
      }

      // 2. urti fra dischetti
      for (let i = 0; i < corpi.length; i++) {
        const a = corpi[i];
        if (!a.vivo) continue;
        for (let j = i + 1; j < corpi.length; j++) {
          const b = corpi[j];
          if (!b.vivo) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= DIAM * DIAM) continue;
          let dist = Math.sqrt(d2);
          let nx, ny;
          if (dist === 0) { nx = 1; ny = 0; dist = 0; } else { nx = dx / dist; ny = dy / dist; }
          const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (vn < 0) {
            const J = -(1 + p.restituzioneDischi) * vn / 2;
            a.vx -= J * nx; a.vy -= J * ny;
            b.vx += J * nx; b.vy += J * ny;
            mossi.add(a.id); mossi.add(b.id);
            if (contatti) contatti.push({ t, a: a.id, b: b.id });
            suoni.push({ t, tipo: 'urto', forza: J });
          }
          // separazione: nessuna sovrapposizione residua
          const sovrapp = DIAM - dist;
          if (sovrapp > 0) {
            const mezzo = sovrapp / 2 + 1e-9;
            a.x -= nx * mezzo; a.y -= ny * mezzo;
            b.x += nx * mezzo; b.y += ny * mezzo;
          }
        }
      }

      // 3. urti contro i pioli
      for (const c of corpi) {
        if (!c.vivo) continue;
        for (const pl of PIOLI) {
          const dx = c.x - pl.x, dy = c.y - pl.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= RP * RP) continue;
          const dist = Math.sqrt(d2) || 1e-12;
          const nx = dx / dist, ny = dy / dist;
          const vn = c.vx * nx + c.vy * ny;
          if (vn < 0) {
            c.vx -= (1 + p.restituzionePioli) * vn * nx;
            c.vy -= (1 + p.restituzionePioli) * vn * ny;
            suoni.push({ t, tipo: 'piolo', forza: -vn });
          }
          const fuori = RP - dist + 1e-9;
          c.x += nx * fuori; c.y += ny * fuori;
        }
      }

      // 4. il buco come avvallamento: frena, attira verso il centro, e il
      //    bordo opposto toglie velocita' all'uscita. La spinta verso il
      //    centro RUOTA la velocita' senza aumentarla: l'energia cinetica
      //    non cresce mai (lo verifica un test).
      for (const c of corpi) {
        if (!c.vivo || bucoOccupato || (c.vx === 0 && c.vy === 0)) { if (c.vivo) c.sopraBuco = false; continue; }
        const r = Math.sqrt(c.x * c.x + c.y * c.y);
        if (r < g.raggioBuco) {
          c.sopraBuco = true;
          let v = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
          const df = p.frenataBuco * p.dt;
          if (v <= df) { c.vx = 0; c.vy = 0; continue; }
          const k = (v - df) / v;
          c.vx *= k; c.vy *= k; v -= df;
          if (p.attrazioneBuco > 0 && r > 1e-9) {
            // angolo fra la velocita' e la direzione verso il centro
            const ux = -c.x / r, uy = -c.y / r;
            const scarto = Math.atan2(c.vx * uy - c.vy * ux, c.vx * ux + c.vy * uy);
            const massimo = p.attrazioneBuco / v * p.dt; // rotazione concessa in questo passo
            const rot = Math.sign(scarto) * Math.min(Math.abs(scarto), massimo);
            const cr = Math.cos(rot), sr = Math.sin(rot);
            const vx = c.vx * cr - c.vy * sr;
            c.vy = c.vx * sr + c.vy * cr;
            c.vx = vx;
          }
        } else if (c.sopraBuco) {
          c.sopraBuco = false;
          if (p.perditaBordo > 0) {
            c.vx *= 1 - p.perditaBordo; c.vy *= 1 - p.perditaBordo;
            suoni.push({ t, tipo: 'bordo', forza: Math.sqrt(c.vx * c.vx + c.vy * c.vy) });
          }
        }
      }

      // 5. caduta nel 20, fossato, arresto
      for (const c of corpi) {
        if (!c.vivo) continue;
        const v = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
        const r = Math.sqrt(c.x * c.x + c.y * c.y);
        // cade se ci passa abbastanza piano vicino al centro, oppure se si
        // FERMA con il centro sopra il buco: il baricentro non e' piu'
        // appoggiato e il dischetto si ribalta dentro
        const cade = !bucoOccupato && mossi.has(c.id) && (
          (r <= p.raggioCattura && v < p.sogliaBuco) ||
          (v < p.velocitaArresto && r < p.raggioRibaltamento));
        if (cade) {
          c.vivo = false; c.vx = 0; c.vy = 0;
          nelBuco.push(c.id);
          bucoOccupato = true;
          c.nelBuco = true;
          mossi.add(c.id);
          suoni.push({ t, tipo: 'venti', id: c.id });
          continue;
        }
        if (r > g.raggioSuperficie) {
          c.vivo = false; c.vx = 0; c.vy = 0;
          nelFossato.push(c.id);
          suoni.push({ t, tipo: 'fossato', id: c.id });
          continue;
        }
        if (v < p.velocitaArresto) { c.vx = 0; c.vy = 0; }
      }

      if (energie) {
        let e = 0;
        for (const c of corpi) if (c.vivo) e += c.vx * c.vx + c.vy * c.vy;
        energie.push(e / 2);
      }

      passo++;
      t = passo * p.dt;
      if (passo % passiPerFoto === 0) fotografa(t);
    }

    // tutto fermo (o tempo scaduto): fotogramma finale
    for (const c of corpi) { c.vx = 0; c.vy = 0; }
    if (istantanee[istantanee.length - 1].t !== t) fotografa(t);

    // traiettoria compatta: solo chi si e' mosso, coordinate a 3 decimali,
    // (0, 0) per chi e' nel buco, null per chi e' finito nel fossato
    const ids = corpi.filter(c => mossi.has(c.id)).map(c => c.id);
    const tondo = x => Math.round(x * 1000) / 1000;
    const foto = istantanee.map(ist => ids.map(id => {
      const q = ist.pos.get(id);
      return q ? [tondo(q[0]), tondo(q[1])] : null;
    }));

    return {
      finali: corpi.filter(c => c.vivo).map(c => ({ id: c.id, squadra: c.squadra, x: c.x, y: c.y })),
      nelBuco,
      nelFossato,
      mossi: [...mossi],
      traiettoria: {
        fps: p.fotogrammiAlSecondo,
        durata: t,
        tempi: istantanee.map(ist => tondo(ist.t)),
        ids,
        foto,
        suoni: suoni.map(s => ({ ...s, t: tondo(s.t), forza: s.forza != null ? tondo(s.forza) : undefined })),
      },
      energie,
      contatti,
    };
  }

  // ------------------------------------------------------------ partita

  /**
   * @param giocatori  nomi in ordine di posto (2 o 4). In 4: [A1, B1, A2, B2]
   *                   cioe' senso orario, compagni di fronte.
   * @param seed       intero: tutta la casualita' (sorteggio, rumore) parte da qui
   * @param fisica     parametri che sovrascrivono FISICA_DEFAULT
   * @param primo      opzionale: chi apre il primo round (altrimenti sorteggio)
   */
  function nuovaPartita({ giocatori, seed = 1, fisica = {}, primo = null }) {
    check(Array.isArray(giocatori) && (giocatori.length === 2 || giocatori.length === 4),
      'Si gioca solo in 2 o in 4');
    let rng = seed >>> 0;
    let apre = primo;
    if (apre === null) {
      const c = prossimoCasuale(rng);
      rng = c.seme;
      apre = Math.floor(c.valore * giocatori.length);
    }
    const stato = {
      n: giocatori.length,
      nomi: [...giocatori],
      seed: seed >>> 0,
      rng,
      fisica: { ...FISICA_DEFAULT, ...fisica },
      punteggi: [0, 0],
      round: 0,
      fase: 'tiro',
      apreIlRound: apre,
      turno: apre,
      daTirare: [],
      dischi: [],
      venti: [0, 0],
      posizione: null,
      prossimoId: 1,
      tiriNelRound: 0,
      ultimoTiro: null,
      riepilogo: null,
      storicoRound: [],
      vincitore: null,
    };
    return iniziaRound(stato, apre);
  }

  function iniziaRound(stato, apre) {
    const perGiocatore = DISCHI_PER_SQUADRA / (stato.n / 2);
    return {
      ...stato,
      round: stato.round + 1,
      fase: 'tiro',
      apreIlRound: apre,
      turno: apre,
      daTirare: Array(stato.n).fill(perGiocatore),
      dischi: [],
      venti: [0, 0],
      posizione: null,
      tiriNelRound: 0,
      ultimoTiro: null,
      riepilogo: null,
    };
  }

  /**
   * Il Giocatore di turno sceglie il punto dell'arco in cui mettere il
   * dischetto. UNA VOLTA SOLA per tiro: messo giu', non si sposta piu' (cosi'
   * un clic distratto non lo sposta mentre si prende la mira).
   */
  function posiziona(stato, posto, phi) {
    check(stato.fase === 'tiro', 'Non è il momento di tirare');
    check(stato.turno === posto, 'Non è il tuo turno');
    check(!stato.posizione, 'Il dischetto è già sul tavolo: ora si tira');
    check(typeof phi === 'number' && Number.isFinite(phi), 'Posizione non valida');
    const pos = posizioneSuArco(stato.n, posto, phi);
    const R2 = 4 * GEOMETRIA.raggioDisco * GEOMETRIA.raggioDisco;
    const occupato = stato.dischi.some(d => (d.x - pos.x) ** 2 + (d.y - pos.y) ** 2 < R2);
    check(!occupato, "Lì c'è già un dischetto");
    return { stato: { ...stato, posizione: { posto, ...pos } }, eventi: [{ tipo: 'posizionato', posto, ...pos }] };
  }

  /** Vero se in quella posizione il dischetto ci starebbe (per l'anteprima). */
  function posizioneLibera(stato, posto, phi) {
    const pos = posizioneSuArco(stato.n, posto, phi);
    const R2 = 4 * GEOMETRIA.raggioDisco * GEOMETRIA.raggioDisco;
    return !stato.dischi.some(d => (d.x - pos.x) ** 2 + (d.y - pos.y) ** 2 < R2);
  }

  /**
   * Il tiro. `angolo` in radianti (coordinate del tavolo), `forza` in [0, 1].
   * Risolve la fisica, applica le regole, passa il turno.
   */
  function tira(stato, posto, { angolo, forza }) {
    check(stato.fase === 'tiro', 'Non è il momento di tirare');
    check(stato.turno === posto, 'Non è il tuo turno');
    check(stato.posizione && stato.posizione.posto === posto, 'Prima scegli dove mettere il dischetto');
    check(typeof angolo === 'number' && Number.isFinite(angolo), 'Angolo non valido');
    check(typeof forza === 'number' && Number.isFinite(forza), 'Forza non valida');
    forza = Math.min(1, Math.max(0, forza));

    const p = stato.fisica;
    let rng = stato.rng;
    if (p.rumoreAngolo > 0) {
      const c = prossimoCasuale(rng); rng = c.seme;
      angolo += (c.valore * 2 - 1) * p.rumoreAngolo;
    }
    if (p.rumoreForza > 0 && forza > 0) {
      const c = prossimoCasuale(rng); rng = c.seme;
      forza = Math.min(1, Math.max(0, forza * (1 + (c.valore * 2 - 1) * p.rumoreForza)));
    }

    const squadra = squadraDi(posto);
    const id = stato.prossimoId;
    const nuovo = { id, squadra, x: stato.posizione.x, y: stato.posizione.y };
    const v = forza * p.velocitaMax;
    const ris = simula([...stato.dischi, nuovo], { id, vx: Math.cos(angolo) * v, vy: Math.sin(angolo) * v }, p);

    return risolvi({ ...stato, rng, prossimoId: id + 1 }, posto, nuovo, ris, { angolo, forza });
  }

  /** Il tempo e' scaduto: tiro a forza zero, cioe' fallo senza simulare. */
  function tiroScaduto(stato, posto) {
    check(stato.fase === 'tiro', 'Non è il momento di tirare');
    check(stato.turno === posto, 'Non è il tuo turno');
    const id = stato.prossimoId;
    const squadra = squadraDi(posto);
    const pos = stato.posizione && stato.posizione.posto === posto
      ? stato.posizione : { ...posizioneSuArco(stato.n, posto, angoloPosto(stato.n, posto)) };
    const nuovo = { id, squadra, x: pos.x, y: pos.y };
    const ris = {
      finali: [...stato.dischi, nuovo], nelBuco: [], nelFossato: [], mossi: [],
      traiettoria: { fps: stato.fisica.fotogrammiAlSecondo, durata: 0, tempi: [0], ids: [], foto: [[]], suoni: [] },
    };
    return risolvi({ ...stato, prossimoId: id + 1 }, posto, nuovo, ris, { angolo: 0, forza: 0, scaduto: true });
  }

  /** Applica le regole al risultato fisico di un tiro. */
  function risolvi(stato, posto, nuovo, ris, tiro) {
    const squadra = nuovo.squadra;
    const avversariPrima = stato.dischi.some(d => d.squadra !== squadra);
    const mossi = new Set(ris.mossi);
    const finaliPerId = new Map(ris.finali.map(d => [d.id, d]));
    const tuttiPrima = new Map([...stato.dischi, nuovo].map(d => [d.id, d]));

    let valido;
    let motivo = null;
    if (avversariPrima) {
      // obbligo di colpire: diretto o indiretto, conta che un avversario si sia mosso
      valido = [...mossi].some(id => tuttiPrima.get(id).squadra !== squadra);
      if (!valido) motivo = 'nessun dischetto avversario colpito';
    } else {
      // tiro aperto (NCA 3a-ii): il tiratore o un dischetto colpito nel 15 (o nel 20)
      valido = ris.nelBuco.some(id => mossi.has(id)) ||
        [...mossi].some(id => finaliPerId.has(id) && raggiungeIl15(finaliPerId.get(id)));
      if (!valido) motivo = 'il tiro aperto non ha raggiunto il 15';
    }
    if (tiro.scaduto) { valido = false; motivo = 'tempo scaduto'; }

    let dischi;
    const venti = [...stato.venti];
    const tolti = [];          // [{id, motivo}]
    const ventiFatti = [];     // [{id, squadra}]

    if (valido) {
      dischi = ris.finali.map(d => ({ ...d }));
      for (const id of ris.nelBuco) {
        const s = tuttiPrima.get(id).squadra;
        venti[s]++;
        ventiFatti.push({ id, squadra: s });
      }
      for (const id of ris.nelFossato) tolti.push({ id, motivo: 'fossato' });
    } else {
      // fallo (NCA 3b): via il tiratore e tutti i dischetti che si sono mossi
      dischi = ris.finali.filter(d => !mossi.has(d.id) && d.id !== nuovo.id).map(d => ({ ...d }));
      for (const id of new Set([nuovo.id, ...mossi])) tolti.push({ id, motivo: 'fallo' });
    }

    // chi tocca o supera la linea esterna e' fuori (NCA 8e)
    dischi = dischi.filter(d => {
      if (toccaLineaEsterna(d)) { tolti.push({ id: d.id, motivo: 'linea esterna' }); return false; }
      return true;
    });

    const daTirare = [...stato.daTirare];
    daTirare[posto]--;

    const esito = {
      posto, squadra, idTirato: nuovo.id, valido, motivo,
      angolo: tiro.angolo, forza: tiro.forza, scaduto: !!tiro.scaduto,
      ventiFatti, tolti,
      partenza: { x: nuovo.x, y: nuovo.y },
    };

    let nuovoStato = {
      ...stato,
      dischi,
      venti,
      daTirare,
      posizione: null,
      tiriNelRound: stato.tiriNelRound + 1,
      ultimoTiro: { esito, traiettoria: ris.traiettoria },
    };
    const eventi = [{ tipo: 'tiro', esito, traiettoria: ris.traiettoria }];

    if (daTirare.every(x => x === 0)) {
      const fine = chiudiRound(nuovoStato);
      nuovoStato = fine.stato;
      eventi.push(...fine.eventi);
    } else {
      nuovoStato.turno = prossimoDiTurno(nuovoStato, posto);
    }
    return { stato: nuovoStato, eventi };
  }

  function prossimoDiTurno(stato, posto) {
    for (let k = 1; k <= stato.n; k++) {
      const q = (posto + k) % stato.n;
      if (stato.daTirare[q] > 0) return q;
    }
    return posto;
  }

  /** Conteggio a cancellazione: segna solo chi ha di piu', e segna la differenza. */
  function contaRound(dischi, venti) {
    const dettaglio = [0, 1].map(s => {
      const miei = dischi.filter(d => d.squadra === s);
      const per = { 20: venti[s], 15: 0, 10: 0, 5: 0 };
      for (const d of miei) { const v = puntiDi(d); if (v) per[v]++; }
      const totale = 20 * per[20] + 15 * per[15] + 10 * per[10] + 5 * per[5];
      return { conteggio: per, totale };
    });
    const diff = dettaglio[0].totale - dettaglio[1].totale;
    const segna = diff > 0 ? 0 : diff < 0 ? 1 : null;
    return { dettaglio, segna, delta: Math.abs(diff) };
  }

  function chiudiRound(stato) {
    const c = contaRound(stato.dischi, stato.venti);
    const punteggi = [...stato.punteggi];
    if (c.segna !== null) punteggi[c.segna] += c.delta;
    const vince = punteggi.findIndex(x => x >= stato.fisica.puntiVittoria);
    const riepilogo = {
      round: stato.round,
      dettaglio: c.dettaglio,
      segna: c.segna,
      delta: c.delta,
      punteggiPrima: [...stato.punteggi],
      punteggi,
    };
    const eventi = [{ tipo: 'round_finito', riepilogo }];
    const st = {
      ...stato,
      punteggi,
      riepilogo,
      storicoRound: [...stato.storicoRound, riepilogo],
      fase: vince >= 0 ? 'finita' : 'fineRound',
      vincitore: vince >= 0 ? vince : null,
      turno: null,
    };
    if (vince >= 0) eventi.push({ tipo: 'partita_finita', vincitore: vince, punteggi });
    return { stato: st, eventi };
  }

  /** Dopo il riepilogo del round: si sgombera e apre il prossimo in senso orario. */
  function continua(stato) {
    check(stato.fase === 'fineRound', 'Il round non è finito');
    const st = iniziaRound(stato, (stato.apreIlRound + 1) % stato.n);
    return { stato: st, eventi: [{ tipo: 'round_iniziato', round: st.round, apre: st.apreIlRound }] };
  }

  // ------------------------------------------------------------ vista

  /**
   * Cosa vede il posto `posto` (null = spettatore). Nel crokinole non c'e'
   * niente di nascosto: si toglie solo lo stato interno del generatore
   * casuale (che permetterebbe di prevedere il rumore del tiro).
   */
  function statoVisibile(stato, posto) {
    return {
      io: posto,
      n: stato.n,
      nomi: stato.nomi,
      fase: stato.fase,
      round: stato.round,
      punteggi: stato.punteggi,
      puntiVittoria: stato.fisica.puntiVittoria,
      apreIlRound: stato.apreIlRound,
      turno: stato.turno,
      daTirare: stato.daTirare,
      dischi: stato.dischi,
      venti: stato.venti,
      posizione: stato.posizione,
      ultimoTiro: stato.ultimoTiro,
      riepilogo: stato.riepilogo,
      storicoRound: stato.storicoRound,
      vincitore: stato.vincitore,
    };
  }

  return {
    GEOMETRIA, FISICA_DEFAULT, PIOLI, DISCHI_PER_SQUADRA,
    MossaIllegale,
    angoloPosto, squadraDi, normalizzaAngolo, posizioneSuArco,
    toccaLineaEsterna, raggiungeIl15, puntiDi, contaRound,
    simula,
    nuovaPartita, posiziona, posizioneLibera, tira, tiroScaduto, continua,
    statoVisibile,
  };
});

// demo a riga di comando, FUORI dalla factory (vedi ARCHITETTURA-GIOCHI.md)
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const C = module.exports;
  const seed = Number(process.argv[2]) || 42;
  let s = C.nuovaPartita({ giocatori: ['Anna', 'Bruno'], seed });
  let x = seed;
  const caso = () => { x = (x * 1103515245 + 12345) >>> 0; return x / 4294967296; };
  while (s.fase !== 'finita') {
    if (s.fase === 'fineRound') {
      const r = s.riepilogo;
      console.log(`Round ${r.round}: ${r.dettaglio[0].totale} a ${r.dettaglio[1].totale} -> ${s.punteggi.join(' - ')}`);
      s = C.continua(s).stato; continue;
    }
    const p = s.turno;
    const centro = C.angoloPosto(s.n, p);
    s = C.posiziona(s, p, centro + (caso() - 0.5) * 1.2).stato;
    const versoCentro = Math.atan2(-s.posizione.y, -s.posizione.x);
    s = C.tira(s, p, { angolo: versoCentro + (caso() - 0.5) * 0.3, forza: 0.35 + caso() * 0.4 }).stato;
  }
  console.log(`Vince la squadra ${s.vincitore}: ${s.punteggi.join(' - ')} in ${s.round} round`);
}
