/**
 * TAVOLO — disegno, gesto della fionda, riproduzione delle traiettorie e
 * suoni. Condiviso fra il gioco (index.html) e il banco di prova
 * (banco.html), cosi' quello che si tara sul banco e' identico a quello che
 * si gioca.
 *
 * Non decide niente: niente regole, niente fisica. Riceve la geometria dal
 * motore (window.Crokinole.GEOMETRIA) e le traiettorie gia' calcolate.
 *
 * UMD come il motore: nel browser diventa window.Tavolo.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.Tavolo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Parametri dell'interfaccia (non della fisica). Centimetri del tavolo,
   * non pixel: cosi' il gesto e' uguale su ogni schermo.
   */
  const UI_DEFAULT = {
    trascinamentoPieno: 11.5, // trascinando di tanti cm si tira a forza 1 (oltre non cresce)
    trascinamentoMinimo: 1,   // sotto: tiro annullato
    // su touch il tavolo e' piccolo e 11.5 cm sono pochi pixel: la forza piena
    // richiede almeno tanti pixel (CSS) di trascinamento; 0 = come col mouse
    pienoMinimoTouchPx: 110,
    lunghezzaFreccia: 2.5,    // freccia di mira; 0 = niente freccia
    quotaElastico: 0.4,       // l'elastico tratteggiato mostra solo questa frazione del trascinamento (0 = niente)
    margineBordo: 3,          // cornice di legno oltre il fossato
    // spazio libero sotto il tavolo, dal lato di chi tira: quanto basta per
    // trascinare fino alla forza piena senza uscire dal riquadro
    spazioTiro: 5.5,
  };

  const COLORI = {
    squadre: [
      { pieno: '#c8372d', bordo: '#7a1a14', luce: '#f08a7e', nome: 'Rossi' },
      { pieno: '#2c5bb0', bordo: '#152f63', luce: '#86aef2', nome: 'Blu' },
    ],
    legno: '#d9b98a',
    legnoScuro: '#b48a57',
    cornice: '#5a3b22',
    fossato: '#2a1a10',
    linee: 'rgba(60, 35, 15, 0.55)',
    piolo: '#c9a24a',
    accento: '#e6b84a',
  };

  // ------------------------------------------------------------ vista

  /**
   * Una vista mappa le coordinate del tavolo (cm, y in su) sullo
   * schermo (pixel, y in giu'), ruotando in modo che `angoloInBasso` (il
   * quarto di chi guarda) stia in basso.
   */
  function creaVista(larghezzaPx, altezzaPx, G, angoloInBasso, ui = UI_DEFAULT) {
    const raggioTot = G.raggioSuperficie + ui.margineBordo + 1.5;
    const larghezzaU = 2 * raggioTot;
    const altezzaU = 2 * raggioTot + ui.spazioTiro;
    const k = Math.min(larghezzaPx / larghezzaU, altezzaPx / altezzaU);
    const cx = larghezzaPx / 2;
    const cy = (altezzaPx - altezzaU * k) / 2 + raggioTot * k; // lo spazio libero resta sotto
    const rot = -Math.PI / 2 - angoloInBasso;
    // su schermo touch piccolo si allunga il trascinamento (vedi pienoMinimoTouchPx)
    const touch = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const pxPerCm = k / ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (touch && ui.pienoMinimoTouchPx && ui.trascinamentoPieno * pxPerCm < ui.pienoMinimoTouchPx) {
      const f = ui.pienoMinimoTouchPx / (ui.trascinamentoPieno * pxPerCm);
      ui = { ...ui, trascinamentoPieno: ui.trascinamentoPieno * f, trascinamentoMinimo: ui.trascinamentoMinimo * f };
    }
    const cr = Math.cos(rot), sr = Math.sin(rot);
    return {
      k, cx, cy, rot, G, ui, larghezzaPx, altezzaPx, angoloInBasso,
      aSchermo(x, y) {
        const xr = x * cr - y * sr, yr = x * sr + y * cr;
        return [cx + xr * k, cy - yr * k];
      },
      daSchermo(sx, sy) {
        const xr = (sx - cx) / k, yr = -(sy - cy) / k;
        return [xr * cr + yr * sr, -xr * sr + yr * cr];
      },
    };
  }

  // ------------------------------------------------------------ disegno

  const cacheSfondo = new Map();

  /** Il tavolo vuoto (cornice, fossato, superficie, linee, buco, pioli), con cache. */
  function disegnaTavolo(ctx, vista, Crokinole) {
    const chiave = [vista.larghezzaPx, vista.altezzaPx, vista.angoloInBasso.toFixed(4)].join('|');
    let off = cacheSfondo.get(chiave);
    if (!off && typeof document !== 'undefined') {
      off = document.createElement('canvas');
      off.width = vista.larghezzaPx; off.height = vista.altezzaPx;
      const c2 = off.getContext('2d');
      if (c2) { disegnaTavoloSu(c2, vista, Crokinole); cacheSfondo.set(chiave, off); }
      else off = null;
      if (cacheSfondo.size > 12) cacheSfondo.delete(cacheSfondo.keys().next().value);
    }
    if (off) ctx.drawImage(off, 0, 0);
    else disegnaTavoloSu(ctx, vista, Crokinole);
  }

  function disegnaTavoloSu(ctx, vista, Crokinole) {
    const G = vista.G;
    const [cx, cy] = vista.aSchermo(0, 0);
    const k = vista.k;
    const cerchio = (r, riempi, tratto, spess) => {
      ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, 2 * Math.PI);
      if (riempi) { ctx.fillStyle = riempi; ctx.fill(); }
      if (tratto) { ctx.strokeStyle = tratto; ctx.lineWidth = spess || 1; ctx.stroke(); }
    };

    // cornice ottagonale come i tavoli veri
    const rc = (G.raggioSuperficie + vista.ui.margineBordo) / Math.cos(Math.PI / 8);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + i * Math.PI / 4;
      const [x, y] = vista.aSchermo(rc * Math.cos(a), rc * Math.sin(a));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const gc = ctx.createLinearGradient(cx - rc * k, cy - rc * k, cx + rc * k, cy + rc * k);
    gc.addColorStop(0, '#7a5232'); gc.addColorStop(1, COLORI.cornice);
    ctx.fillStyle = gc; ctx.fill();

    // fossato
    cerchio(G.raggioSuperficie + vista.ui.margineBordo * 0.55, COLORI.fossato);

    // superficie
    const gs = ctx.createRadialGradient(cx - 7.5 * k, cy - 10 * k, 2.5 * k, cx, cy, G.raggioSuperficie * k);
    gs.addColorStop(0, '#ecd3a8'); gs.addColorStop(0.7, COLORI.legno); gs.addColorStop(1, COLORI.legnoScuro);
    cerchio(G.raggioSuperficie, gs);

    // venature leggere
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, G.raggioSuperficie * k, 0, 2 * Math.PI); ctx.clip();
    ctx.strokeStyle = 'rgba(120, 80, 40, 0.07)';
    ctx.lineWidth = Math.max(1, k * 0.2);
    for (let i = -36; i <= 36; i += 2.3) {
      ctx.beginPath();
      const [x1, y1] = vista.aSchermo(i, -36), [x2, y2] = vista.aSchermo(i + 3.8, 36);
      ctx.moveTo(x1, y1); ctx.quadraticCurveTo((x1 + x2) / 2 + k * 1.5, (y1 + y2) / 2, x2, y2);
      ctx.stroke();
    }
    ctx.restore();

    // zone: il 15 un filo piu' scuro, per leggerlo a colpo d'occhio
    cerchio(G.raggio15, 'rgba(120, 70, 30, 0.10)');

    const spess = Math.max(1, k * 0.15);
    cerchio(G.raggioEsterno, null, COLORI.linee, spess * 1.4);
    cerchio(G.raggio10, null, COLORI.linee, spess);
    cerchio(G.raggio15, null, COLORI.linee, spess);

    // linee dei quarti, dal 10 alla linea esterna
    ctx.strokeStyle = COLORI.linee; ctx.lineWidth = spess;
    for (const a of [Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4]) {
      const [x1, y1] = vista.aSchermo(G.raggio10 * Math.cos(a), G.raggio10 * Math.sin(a));
      const [x2, y2] = vista.aSchermo(G.raggioEsterno * Math.cos(a), G.raggioEsterno * Math.sin(a));
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // buco del 20
    const gb = ctx.createRadialGradient(cx, cy, 0, cx, cy, G.raggioBuco * k);
    gb.addColorStop(0, '#120b06'); gb.addColorStop(1, '#3d2614');
    cerchio(G.raggioBuco, gb, 'rgba(0,0,0,0.5)', spess);

    // pioli
    for (const p of Crokinole.PIOLI) {
      const [x, y] = vista.aSchermo(p.x, p.y);
      ctx.beginPath(); ctx.arc(x + k * 0.13, y + k * 0.18, G.raggioPiolo * k, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      const gp = ctx.createRadialGradient(x - k * 0.15, y - k * 0.15, 0, x, y, G.raggioPiolo * k);
      gp.addColorStop(0, '#f3dc95'); gp.addColorStop(1, '#8a6a2a');
      ctx.beginPath(); ctx.arc(x, y, G.raggioPiolo * k, 0, 2 * Math.PI);
      ctx.fillStyle = gp; ctx.fill();
    }
  }

  /** Un dischetto. `opz.alfa` per le anteprime, `opz.alone` per evidenziarlo. */
  function disegnaDisco(ctx, vista, x, y, squadra, opz = {}) {
    const G = vista.G, k = vista.k;
    const [sx, sy] = vista.aSchermo(x, y);
    const r = G.raggioDisco * k;
    const col = COLORI.squadre[squadra];
    ctx.save();
    ctx.globalAlpha = opz.alfa ?? 1;
    if (opz.alone) {
      ctx.beginPath(); ctx.arc(sx, sy, r * 1.35, 0, 2 * Math.PI);
      ctx.fillStyle = opz.alone; ctx.fill();
    }
    if (!opz.alfa || opz.alfa === 1) {
      ctx.beginPath(); ctx.arc(sx + r * 0.08, sy + r * 0.12, r, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
    }
    const g = ctx.createRadialGradient(sx - r * 0.35, sy - r * 0.35, r * 0.1, sx, sy, r);
    g.addColorStop(0, col.luce);
    g.addColorStop(1, col.pieno);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.1); ctx.strokeStyle = col.bordo; ctx.stroke();
    // anello inciso, come i dischetti veri
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.62, 0, 2 * Math.PI);
    ctx.lineWidth = Math.max(0.5, r * 0.06);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke();
    if (opz.vietato) {
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = Math.max(2, r * 0.18);
      ctx.beginPath(); ctx.moveTo(sx - r * 0.6, sy - r * 0.6); ctx.lineTo(sx + r * 0.6, sy + r * 0.6); ctx.stroke();
    }
    ctx.restore();
  }

  /** L'elastico della fionda e la freccia corta di mira. */
  function disegnaMira(ctx, vista, partenza, puntatore, mira) {
    const k = vista.k;
    const [sx, sy] = vista.aSchermo(partenza.x, partenza.y);
    // l'elastico e' volutamente corto: si vede che si sta tirando, ma non e'
    // un righello per ripetere sempre lo stesso tiro. Smette di allungarsi
    // quando la forza e' al massimo.
    const q = vista.ui.quotaElastico;
    let dx = puntatore.x - partenza.x, dy = puntatore.y - partenza.y;
    const L0 = Math.hypot(dx, dy), Lmax = vista.ui.trascinamentoPieno;
    if (L0 > Lmax) { dx *= Lmax / L0; dy *= Lmax / L0; }
    const [px, py] = vista.aSchermo(partenza.x + dx * q, partenza.y + dy * q);
    ctx.save();
    ctx.strokeStyle = mira.annullato ? 'rgba(255,255,255,0.25)' : 'rgba(255, 240, 210, 0.45)';
    ctx.lineWidth = Math.max(1, k * 0.2);
    ctx.setLineDash([k * 0.6, k * 0.5]);
    if (q > 0) { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(px, py); ctx.stroke(); }
    ctx.setLineDash([]);
    const L = vista.ui.lunghezzaFreccia;
    if (L > 0 && !mira.annullato) {
      const tx = partenza.x + Math.cos(mira.angolo) * L, ty = partenza.y + Math.sin(mira.angolo) * L;
      const [ex, ey] = vista.aSchermo(tx, ty);
      ctx.strokeStyle = COLORI.accento; ctx.fillStyle = COLORI.accento;
      ctx.lineWidth = Math.max(2, k * 0.3);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      const ang = Math.atan2(ey - sy, ex - sx), p = k * 1.15;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - p * Math.cos(ang - 0.45), ey - p * Math.sin(ang - 0.45));
      ctx.lineTo(ex - p * Math.cos(ang + 0.45), ey - p * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ gesto

  /**
   * Dal trascinamento alla mira. `partenza` e `puntatore` in coordinate del
   * tavolo. Si tira nel verso OPPOSTO al trascinamento, con forza
   * proporzionale alla lunghezza (misurata in cm del tavolo, quindi
   * uguale su ogni schermo).
   */
  function miraDaTrascinamento(partenza, puntatore, ui = UI_DEFAULT) {
    const dx = partenza.x - puntatore.x, dy = partenza.y - puntatore.y;
    const L = Math.hypot(dx, dy);
    return {
      angolo: Math.atan2(dy, dx),
      forza: Math.min(1, L / ui.trascinamentoPieno),
      annullato: L < ui.trascinamentoMinimo,
    };
  }

  /** Il punto del tavolo e' sopra il dischetto (con un po' di tolleranza)? */
  function sopraIlDisco(punto, disco, G, tolleranza = 1.6) {
    return Math.hypot(punto.x - disco.x, punto.y - disco.y) <= G.raggioDisco * tolleranza;
  }

  /** Il punto e' vicino alla linea di tiro (per l'anteprima del posizionamento)? */
  function vicinoAllArco(punto, G, fascia = 4.5) {
    return Math.abs(Math.hypot(punto.x, punto.y) - G.raggioEsterno) <= fascia;
  }

  // ------------------------------------------------------------ riproduzione

  /**
   * Posizioni dei dischetti mossi all'istante `t` della traiettoria,
   * interpolate linearmente. Map id -> {x, y} oppure null (sparito).
   */
  function posizioniAl(traiettoria, t) {
    const { tempi, foto, ids } = traiettoria;
    const out = new Map();
    if (!ids.length) return out;
    let i = tempi.length - 1;
    if (t <= 0) i = 0;
    else {
      // i fotogrammi sono regolari tranne l'ultimo: stima e correggi
      i = Math.min(tempi.length - 1, Math.floor(t * traiettoria.fps));
      while (i > 0 && tempi[i] > t) i--;
      while (i < tempi.length - 1 && tempi[i + 1] <= t) i++;
    }
    const j = Math.min(i + 1, tempi.length - 1);
    const span = tempi[j] - tempi[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - tempi[i]) / span)) : 0;
    ids.forEach((id, n) => {
      const a = foto[i][n], b = foto[j][n];
      if (!a) { out.set(id, null); return; }
      if (!b) { out.set(id, f < 0.5 ? { x: a[0], y: a[1] } : null); return; }
      out.set(id, { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f });
    });
    return out;
  }

  // ------------------------------------------------------------ suoni

  /**
   * Suoni sintetizzati con WebAudio: niente file da scaricare. Si accendono
   * al primo gesto dell'utente (i browser non permettono audio prima).
   */
  function creaSuoni() {
    let ac = null;
    let muto = false;
    try { muto = localStorage.getItem('crokinole-muto') === '1'; } catch (e) {}
    const contesto = () => {
      if (ac) return ac;
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;
      try { ac = new AC(); } catch (e) { ac = null; }
      return ac;
    };
    function colpo(freq, durata, volume, rumore) {
      const c = contesto();
      if (!c || muto) return;
      if (c.state === 'suspended') c.resume();
      const t0 = c.currentTime;
      const g = c.createGain();
      g.gain.setValueAtTime(Math.min(0.9, volume), t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + durata);
      g.connect(c.destination);
      if (rumore) {
        const n = Math.floor(c.sampleRate * durata);
        const buf = c.createBuffer(1, n, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const src = c.createBufferSource(); src.buffer = buf;
        const filtro = c.createBiquadFilter(); filtro.type = 'bandpass'; filtro.frequency.value = freq; filtro.Q.value = 2;
        src.connect(filtro); filtro.connect(g); src.start(t0);
      } else {
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(freq, t0);
        o.frequency.exponentialRampToValueAtTime(freq * 0.5, t0 + durata);
        o.connect(g); o.start(t0); o.stop(t0 + durata);
      }
    }
    return {
      get muto() { return muto; },
      set muto(v) { muto = !!v; try { localStorage.setItem('crokinole-muto', muto ? '1' : '0'); } catch (e) {} },
      sblocca() { const c = contesto(); if (c && c.state === 'suspended') c.resume(); },
      suona(s) {
        if (s.tipo === 'urto') colpo(1800, 0.06, 0.15 + Math.min(0.6, (s.forza || 0) / 40), true);
        else if (s.tipo === 'piolo') colpo(2600, 0.05, 0.1 + Math.min(0.5, (s.forza || 0) / 50), true);
        else if (s.tipo === 'venti') colpo(140, 0.35, 0.6, false);
        else if (s.tipo === 'fossato') colpo(300, 0.15, 0.2, true);
        else if (s.tipo === 'bordo') colpo(700, 0.06, 0.1 + Math.min(0.4, (s.forza || 0) / 60), true);
        else if (s.tipo === 'tiro') colpo(900, 0.05, 0.25, true);
      },
    };
  }

  return {
    UI_DEFAULT, COLORI,
    creaVista, disegnaTavolo, disegnaDisco, disegnaMira,
    miraDaTrascinamento, sopraIlDisco, vicinoAllArco,
    posizioniAl, creaSuoni,
  };
});
