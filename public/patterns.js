/* public/patterns.js
 * Detector de DOBLE SUELO (W) y DOBLE TECHO (M) con ruptura de línea de cuello,
 * en TRES temporalidades: velas 15m (~24h), 1h (~8 días) y 4h (~8 días).
 *
 * Las velas de 4h no vienen del servidor: se agregan aquí a partir de las 200
 * velas de 1h que ya trae cada fila (row.k60), igual que core.js agrega las de
 * 15m desde las de 5m. Sin coste de red: 200 velas de 1h → 50 velas de 4h.
 *
 * Método (idéntico en las tres TF, con parámetros propios):
 *  1. Pivotes: mínimo/máximo local = extremo de una ventana de ±N velas.
 *  2. Doble suelo: dos pivotes-mínimo casi al mismo precio (tolerancia en ATR,
 *     no en % fijo — comparable entre monedas), con un rebote intermedio de
 *     profundidad ≥ 1 ATR. El máximo de ese rebote ES la línea de cuello.
 *     Doble techo = espejo.
 *  3. Estados:  formándose → ⏳ confirmando (el precio cruza el cuello
 *     intra-vela: visible pero SIN alertar ni dar seguimiento) → ⚡ ROMPIENDO
 *     (una vela YA CERRADA de la misma temporalidad cerró más allá del cuello:
 *     arriba en W, abajo en M → ALERTA + seguimiento) → roto/confirmado.
 *     La confirmación por cierre filtra los fakeouts intra-vela.
 *  4. Invalidación: si el precio perfora los suelos/techos, el patrón muere.
 *  5. Objetivo = cuello ± profundidad (movimiento medido) · stop = extremos ∓ 0.3 ATR.
 */

const PATTERN_CFG = {          // ── velas 15m ──
  tf:           '15m',
  ms:           900_000,   // duración de una vela, para fechar la ruptura
  minBars:      30,    // mínimo de velas para intentar la detección
  pivotWin:     2,     // pivote = extremo de ±2 velas (30 min a cada lado)
  tolExtremes:  0.35,  // |suelo1 − suelo2| ≤ 0.35 × ATR(15m)
  minDepth:     1.0,   // profundidad valle→cuello ≥ 1 × ATR
  minSep:       4,     // separación mínima entre extremos (velas = 1h)
  maxSep:       40,    // separación máxima (= 10h)
  maxAge2nd:    16,    // el 2º extremo debe estar en las últimas 16 velas (4h)
  breakWindow:  2,     // "ROMPIENDO" = cruce del cuello en las últimas 2 velas (30 min)
};

const PATTERN_CFG_1H = {       // ── velas 1h (estructura de swing más grande) ──
  tf:           '1h',
  ms:           3_600_000,
  minBars:      20,
  pivotWin:     2,     // pivote = extremo de ±2 velas (2h a cada lado)
  tolExtremes:  0.4,   // algo más tolerante: los extremos de 1h son más rugosos
  minDepth:     1.0,
  minSep:       3,     // 3h mínimo entre suelos
  maxSep:       30,    // hasta 30h (limitado por las ~50 velas disponibles)
  maxAge2nd:    10,    // el 2º extremo en las últimas 10 velas (10h)
  breakWindow:  2,     // cruce del cuello en las últimas 2 velas (2h)
};

const PATTERN_CFG_4H = {       // ── velas 4h (swing de varios días) ──
  tf:           '4h',
  ms:           14_400_000,
  minBars:      24,    // de las ~50 velas de 4h que salen de las 200 de 1h
  pivotWin:     2,     // pivote = extremo de ±2 velas (8h a cada lado)
  tolExtremes:  0.45,  // los extremos de 4h son los más rugosos de las tres TF
  minDepth:     1.0,
  minSep:       3,     // 12h mínimo entre suelos
  maxSep:       20,    // hasta 80h (~3,3 días), dentro de las 50 velas disponibles
  maxAge2nd:    8,     // el 2º extremo en las últimas 8 velas (32h)
  breakWindow:  2,     // cruce del cuello en las últimas 2 velas (8h)
};


// ── ¿Llego tarde? ───────────────────────────────────────────────────────────
// Un patrón se ve en pantalla mucho después de romper el cuello, y nada decía
// CUÁNDO ocurrió: una W confirmada hace 1 hora y otra confirmada hace 9 se
// mostraban igual. Estas tres funciones responden a eso.

// "hace 25m" · "hace 1.5h" · "hace 2.1 días"
function patAgo(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const m = ms / 60_000;
  if (m < 60) return 'hace ' + Math.round(m) + 'm';
  const h = ms / 3_600_000;
  if (h < 48) return 'hace ' + (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
  return 'hace ' + (h / 24).toFixed(1) + ' días';
}

// La antigüedad se mide en VELAS DE SU PROPIA TEMPORALIDAD, no en tiempo
// absoluto: una vela tras la ruptura son 15 min en 15m pero 4 horas en 4h, así
// que "hace 4h" es tardísimo en 15m y es acabar de romper en 4h.
function patLateness(p) {
  if (!p || p.barsSinceBreak == null) return null;
  const b = p.barsSinceBreak;
  const u = 'vela' + (b === 1 ? '' : 's') + ' de ' + p.tf;
  return b <= 0 ? { bars: b, txt: 'recién rota (misma vela)', color: '#2fe08a' }
       : b === 1 ? { bars: b, txt: '1 ' + u + ' desde la ruptura', color: '#ffbe3c' }
       : { bars: b, txt: b + ' ' + u + ' desde la ruptura', color: '#ff9a9a' };
}

// La otra mitad de "¿entro tarde?": el precio puede haber roto hace nada y
// haberse comido ya medio recorrido hasta el objetivo. 0% = justo en el cuello,
// 100% = objetivo alcanzado. Negativo = ha vuelto por detrás del cuello.
function patProgress(p, price) {
  if (!p || p.target == null || price == null) return null;
  const total = p.target - p.neckline;
  if (!total) return null;
  return (price - p.neckline) / total * 100;
}

// ── El retroceso al cuello: la unica entrada que paga comision maker ─────────
// Una ruptura solo se puede tomar a mercado, y el barrido de
// backtest/RESULTADOS-SCALP.md es contundente: 0 de 1.728 configuraciones de
// scalping resultaron rentables a comision taker (0,055%/lado) frente a 44 de
// 1.728 a comision maker (0,020%). La comision no es un ajuste fino, es la
// variable que decide si hay estrategia.
//
// La orden limite espera en el cuello ya roto, que pasa de resistencia a soporte
// (al reves en la M). No es un truco de backtest: es la forma natural de operar
// un retest. Lo que si es un supuesto es que la orden se llene -- si el precio
// no vuelve, la operacion no existe-- y por eso el Lab cuenta aparte las
// rupturas que se fueron sin dar entrada.
const RETEST_STOP_ATR_UI = 0.5;   // stop al otro lado del cuello (igual que en lab.js)
const RETEST_ZONE_ATR    = 0.15;  // margen alrededor del cuello que cuenta como "en zona"

function patRetest(p, price) {
  if (!p || price == null || p.neckline == null || !p.atr) return null;
  if (p.state !== 'breaking' && p.state !== 'broken') return null;
  const isW = p.type === 'W';
  const level = p.neckline;                                   // el limite va en el cuello
  const stop  = isW ? level - RETEST_STOP_ATR_UI * p.atr
                    : level + RETEST_STOP_ATR_UI * p.atr;
  const risk  = Math.abs(level - stop);
  const rr    = risk > 0 ? Math.abs(p.target - level) / risk : null;
  // Cuanto le falta al precio para llegar al limite (>0 = todavia no).
  const dist = isW ? (price - level) : (level - price);
  const zone = RETEST_ZONE_ATR * p.atr;
  const state = dist <= 0   ? 'reached'   // ya en el cuello o por detras: la orden habria entrado
              : dist <= zone ? 'active'   // se llenaria ahora mismo
              : 'waiting';                // la ruptura se ha ido, la orden espera
  return { level, stop, rr, dist, distPct: price ? dist / price * 100 : null, zone, state };
}

// ── Pivotes (fractales) ──────────────────────────────────────────────────────
function _patPivots(k, win) {
  const piv = [];
  for (let i = win; i < k.c.length - win; i++) {
    let isH = true, isL = true;
    for (let j = i - win; j <= i + win; j++) {
      if (j === i) continue;
      if (k.h[j] >= k.h[i]) isH = false;
      if (k.l[j] <= k.l[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) piv.push({ i, price: k.h[i], type: 'H' });
    if (isL) piv.push({ i, price: k.l[i], type: 'L' });
  }
  return piv;
}

// ATR simple (true range medio de las últimas 40 velas de la serie que sea)
function _patAtr(k) {
  const n = k.c.length;
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, n - 40); i < n; i++) {
    sum += Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1]));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// ── Detección genérica sobre una serie de velas con una config de TF ─────────
function _detectDouble(k, C) {
  if (!k || k.c.length < C.minBars) return null;
  const n = k.c.length;
  const atr = _patAtr(k);
  if (!atr) return null;

  const piv   = _patPivots(k, C.pivotWin);
  const lows  = piv.filter(p => p.type === 'L');
  const highs = piv.filter(p => p.type === 'H');
  const last  = k.c[n - 1];

  const scan = (exts, mids, isBottom) => {
    let best = null;
    const rank = c => (c.state === 'breaking' ? 3000 : c.state === 'confirming' ? 2000 : c.state === 'forming' ? 1000 : 0) + c.p2.i;
    for (let b = exts.length - 1; b >= 1; b--) {
      const P2 = exts[b];
      if (n - 1 - P2.i > C.maxAge2nd) break; // los siguientes son aún más viejos
      for (let a = b - 1; a >= 0; a--) {
        const P1 = exts[a];
        const sep = P2.i - P1.i;
        if (sep < C.minSep) continue;
        if (sep > C.maxSep) break;
        if (Math.abs(P1.price - P2.price) > C.tolExtremes * atr) continue;

        // Línea de cuello: el pivote contrario más extremo ENTRE ambos
        const between = mids.filter(m => m.i > P1.i && m.i < P2.i);
        if (!between.length) continue;
        const neck = isBottom
          ? between.reduce((x, y) => (y.price > x.price ? y : x))
          : between.reduce((x, y) => (y.price < x.price ? y : x));
        const extLevel = isBottom ? Math.min(P1.price, P2.price) : Math.max(P1.price, P2.price);
        const depth = Math.abs(neck.price - extLevel);
        if (depth < C.minDepth * atr) continue;

        // Invalidación: tras el 2º extremo el precio no debe perforar los extremos
        let invalid = false;
        for (let i = P2.i + 1; i < n; i++) {
          if (isBottom ? k.l[i] < extLevel - 0.25 * atr : k.h[i] > extLevel + 0.25 * atr) { invalid = true; break; }
        }
        if (invalid) continue;

        // Estado respecto al cuello — con CONFIRMACIÓN DE CIERRE DE VELA:
        // la ruptura solo se confirma cuando una vela YA CERRADA de esta
        // temporalidad cierra más allá del cuello (arriba en W, abajo en M).
        // La vela en curso (última, con precio vivo) NO confirma: mientras
        // cruza sin cerrar el estado es 'confirming' (visible, sin alertar).
        const neckP = neck.price;
        const lastClosed = n - 2; // índice de la última vela CERRADA
        const crossedClosed = [];
        for (let i = P2.i + 1; i <= lastClosed; i++) {
          const c0 = k.c[i - 1], c1 = k.c[i];
          if (isBottom ? (c1 > neckP && c0 <= neckP) : (c1 < neckP && c0 >= neckP)) crossedClosed.push(i);
        }
        const lastCross = crossedClosed.length ? crossedClosed[crossedClosed.length - 1] : null;
        const beyondLive   = isBottom ? last > neckP : last < neckP;
        const beyondClosed = lastClosed > P2.i && (isBottom ? k.c[lastClosed] > neckP : k.c[lastClosed] < neckP);
        let state = 'forming';
        if (lastCross != null && beyondClosed && lastClosed - lastCross < C.breakWindow) state = 'breaking'; // CONFIRMADA por cierre
        else if (lastCross != null && beyondClosed) state = 'broken';    // confirmada hace más velas
        else if (beyondLive) state = 'confirming';                       // cruzando intra-vela, esperando cierre
        // si cruzó pero la última vela cerrada volvió al otro lado → fakeout → 'forming'

        // Calidad 0-10: similitud de extremos + profundidad + volumen en la ruptura
        const sim   = 1 - Math.abs(P1.price - P2.price) / (C.tolExtremes * atr); // 0-1
        const depQ  = Math.min(1, depth / (2.5 * atr));
        let volQ = 0;
        if (lastCross != null) {
          const avgV = k.v.slice(Math.max(0, n - 30)).reduce((x, y) => x + y, 0) / Math.min(30, n);
          if (avgV > 0) volQ = Math.min(1, k.v[lastCross] / (avgV * 2));
        }
        const quality = Math.round((sim * 3.5 + depQ * 4 + volQ * 2.5) * 10) / 10;

        const cand = {
          type: isBottom ? 'W' : 'M',
          tf: C.tf,
          state, quality,
          neckline: neckP, neckIdx: neck.i,
          p1: P1, p2: P2, depth, atr,
          target: isBottom ? neckP + depth : neckP - depth,
          stop:   isBottom ? extLevel - 0.3 * atr : extLevel + 0.3 * atr,
          breakIdx: lastCross,
          // ── Antigüedad, para saber si se llega tarde ──
          // breakAt = instante en que CERRÓ la vela que rompió el cuello
          // (k.t es la apertura, así que se le suma la duración de la vela).
          breakAt: (lastCross != null && k.t) ? k.t[lastCross] + C.ms : null,
          barsSinceBreak: lastCross != null ? lastClosed - lastCross : null,
          startAt: k.t ? k.t[P1.i] : null,   // apertura del 1er extremo
          spanBars: P2.i - P1.i,             // velas entre los dos extremos
        };
        if (!best || rank(cand) > rank(best)) best = cand;
      }
    }
    return best;
  };

  const W = scan(lows, highs, true);
  const M = scan(highs, lows, false);
  if (W && M) {
    const pr = c => (c.state === 'breaking' ? 3 : c.state === 'confirming' ? 2 : c.state === 'forming' ? 1 : 0);
    return pr(W) !== pr(M) ? (pr(W) > pr(M) ? W : M) : (W.p2.i >= M.p2.i ? W : M);
  }
  return W || M;
}

// ── Velas de 4h agregadas desde las de 1h ───────────────────────────────────
// row.k60 trae 200 velas de 1h (~8 días) → 50 velas de 4h. Buckets alineados al
// reloj UTC (00/04/08/12/16/20), que es como los reparte cualquier exchange, así
// que el cuello coincide con el que se ve en un gráfico de 4h normal.
// El resultado se cachea en la propia fila: allRows se reconstruye entera en
// cada ciclo (main.js L34), así que la caché se invalida sola.
function _patAgg4h(row) {
  if (row._k240) return row._k240;
  const k = row.k60;
  if (!k || !k.t || k.c.length < 8) return null;
  const a = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let bucket = -1;
  for (let i = 0; i < k.c.length; i++) {
    const b = Math.floor(k.t[i] / 14_400_000); // bucket de 4h
    if (b !== bucket) {
      bucket = b;
      a.t.push(b * 14_400_000); a.o.push(k.o[i]); a.h.push(k.h[i]);
      a.l.push(k.l[i]); a.c.push(k.c[i]); a.v.push(k.v[i]);
    } else {
      const j = a.c.length - 1;
      a.h[j] = Math.max(a.h[j], k.h[i]);
      a.l[j] = Math.min(a.l[j], k.l[i]);
      a.c[j] = k.c[i];
      a.v[j] += k.v[i];
    }
  }
  row._k240 = a;
  return a;
}

// Mejor patrón vigente por fila del screener, en cada temporalidad
function detectDoublePattern(row)   { return _detectDouble(row.k15, PATTERN_CFG); }
function detectDoublePattern1h(row) { return _detectDouble(row.k60, PATTERN_CFG_1H); }
function detectDoublePattern4h(row) { return _detectDouble(_patAgg4h(row), PATTERN_CFG_4H); }

// ── Escaneo por ciclo + alertas de ruptura de cuello ────────────────────────
const _patPrevState = new Map(); // sym|tf → 'W:breaking' etc. (transiciones)
const _patAlertAt   = new Map(); // sym|type|tf → ts de la última alerta (cooldown)
const _patRetestState = new Map(); // sym|tf → 'waiting'|'active'|'reached' del retroceso

// Categoría de alerta y cooldown por temporalidad. El cooldown crece con la
// vela: la misma ruptura sigue "viva" mientras la vela no cierre, así que en 4h
// avisar cada 30 min sería el mismo aviso repetido ocho veces.
const _PAT_ALERT_CAT = { '15m': 'pattern15', '1h': 'pattern1h', '4h': 'pattern4h' };
const _PAT_COOLDOWN  = { '15m': 30 * 60_000, '1h': 2 * 3600_000, '4h': 8 * 3600_000 };

function _patAlerts(r, p, tf, breakingEntries) {
  if (!p) {
    _patPrevState.set(r.symbol + '|' + tf, null);
    _patRetestState.delete(r.symbol + '|' + tf);
    return;
  }
  const cur = p.type + ':' + p.state;
  const prev = _patPrevState.get(r.symbol + '|' + tf);

  // ── El precio vuelve al cuello: momento de la entrada con orden limite ──────
  // Se avisa al ENTRAR en la zona, no mientras siga dentro, y con el mismo
  // cooldown por temporalidad que la ruptura.
  const rt = patRetest(p, r.price);
  const rkey = r.symbol + '|' + tf;
  const rprev = _patRetestState.get(rkey);
  if (rt) {
    const enZona = rt.state === 'active' || rt.state === 'reached';
    if (enZona && rprev === 'waiting') {
      const key = rkey + '|retest|' + p.type;
      const lastAlert = _patAlertAt.get(key) || 0;
      const cooldown = _PAT_COOLDOWN[tf] ?? 30 * 60_000;
      if (canAlert('patternRetest') && Date.now() - lastAlert > cooldown) {
        _patAlertAt.set(key, Date.now());
        const isW = p.type === 'W';
        showToast(
          `⏳ ${r.symbol} (${tf}) — el precio VOLVIÓ al cuello ${fmtPrice(rt.level)}: entrada con orden límite${rt.rr ? ` · R:R ${rt.rr.toFixed(1)}:1` : ''}`,
          isW ? 'long' : 'short');
        playAlertSound('patternRetest', isW ? 'long' : 'short');
        notifyDesktop(
          `⏳ ${r.symbol} (${tf}) — retroceso al cuello ${isW ? 'de la W' : 'de la M'}`,
          `Orden límite en ${fmtPrice(rt.level)} · stop ${fmtPrice(rt.stop)} · objetivo ${fmtPrice(p.target)}${rt.rr ? ` · R:R ${rt.rr.toFixed(1)}:1` : ''} — comisión maker`);
      }
    }
    _patRetestState.set(rkey, rt.state);
  } else {
    _patRetestState.delete(rkey);
  }

  if (p.state === 'breaking') {
    const isW = p.type === 'W';
    breakingEntries.push({ symbol: r.symbol, side: isW ? 'l' : 's', score: p.quality });

    if (prev !== cur) {
      // Seguimiento hasta que se complete (objetivo o stop) — ver lab.js
      if (typeof trackPatternSignal === 'function') trackPatternSignal(r, p);

      const key = r.symbol + '|' + p.type + '|' + tf;
      const lastAlert = _patAlertAt.get(key) || 0;
      const cat = _PAT_ALERT_CAT[tf] || 'pattern15';
      const cooldown = _PAT_COOLDOWN[tf] ?? 30 * 60_000;
      if (canAlert(cat) && Date.now() - lastAlert > cooldown) {
        _patAlertAt.set(key, Date.now());
        const tfTag = ' (' + tf + ')';
        showToast(`${isW ? '🟢 DOBLE SUELO' : '🔴 DOBLE TECHO'}${tfTag} ${r.symbol} — ¡ruptura de cuello CONFIRMADA con cierre de vela!`, isW ? 'long' : 'short');
        playAlertSound(cat, isW ? 'long' : 'short');
        notifyDesktop(
          `${isW ? '🟢 W' : '🔴 M'}${tfTag} ${r.symbol} — ruptura de cuello confirmada`,
          `Vela ${tf} cerró ${isW ? 'sobre' : 'bajo'} el cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · stop ${fmtPrice(p.stop)} · calidad ${p.quality}/10`
        );
      }
    }
  }
  _patPrevState.set(r.symbol + '|' + tf, cur);
}

function scanPatterns(rows) {
  const breaking15 = []; // rompiendo cuello AHORA en 15m (→ Comparador 'patternWM')
  const breaking1h = []; // ídem en 1h (→ 'patternWM1h', evidencia separada)
  const breaking4h = []; // ídem en 4h (→ 'patternWM4h', evidencia separada)
  for (const r of rows) {
    r.pattern   = detectDoublePattern(r);
    r.pattern1h = detectDoublePattern1h(r);
    r.pattern4h = detectDoublePattern4h(r);
    _patAlerts(r, r.pattern,   '15m', breaking15);
    _patAlerts(r, r.pattern1h, '1h',  breaking1h);
    _patAlerts(r, r.pattern4h, '4h',  breaking4h);
  }

  // Comparador: cada TF acumula su PROPIA evidencia (misma vara que las demás
  // estrategias: n≥30 y WR≥55% antes de considerarla operable).
  if (typeof logPanelDetections === 'function') {
    logPanelDetections('patternWM', breaking15);
    logPanelDetections('patternWM1h', breaking1h);
    logPanelDetections('patternWM4h', breaking4h);
  }

  // Resuelve objetivo/stop de los patrones en seguimiento — SIEMPRE, tenga o
  // no la pestaña Lab abierta.
  if (typeof checkPatternTrackOutcomes === 'function') checkPatternTrackOutcomes();
  // Y las entradas cuya moneda ya salió del universo, contra el histórico de
  // precios del servidor. Va sin await a propósito: es una petición de red y no
  // debe retrasar el pintado del ciclo. Se autolimita a una cada 5 min.
  if (typeof resolveOrphanPatternTracks === 'function') resolveOrphanPatternTracks();

  renderPatternStrip(rows);
}

// ── Badges junto al símbolo en la tabla (uno por temporalidad) ──────────────
function _patBadgeOne(row, p, tf) {
  if (!p) return '';
  const isW = p.type === 'W';
  const stateTxt = p.state === 'breaking' ? 'RUPTURA CONFIRMADA (cierre de vela ' + tf + ')'
                 : p.state === 'confirming' ? 'cruzando el cuello — ESPERANDO CIERRE de vela ' + tf
                 : p.state === 'forming' ? 'formándose' : 'cuello roto';
  const ageTxt = p.breakAt ? ` · rompió ${patAgo(Date.now() - p.breakAt)}` : '';
  // El retroceso al cuello es la entrada que paga comisión maker: si está en
  // zona, es más accionable que la propia ruptura y el badge lo dice.
  const rt = patRetest(p, row.price);
  const rtTxt = !rt ? ''
    : rt.state === 'waiting'
      ? ` · ⏳ orden límite en el cuello ${fmtPrice(rt.level)} (falta ${rt.distPct.toFixed(2)}%)`
      : ` · ⏳ EL PRECIO ESTÁ EN EL CUELLO ${fmtPrice(rt.level)} — entrada con orden límite${rt.rr ? `, R:R ${rt.rr.toFixed(1)}:1` : ''}`;
  const title = `${isW ? 'Doble suelo (W)' : 'Doble techo (M)'} en ${tf} — ${stateTxt}${ageTxt} · cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · stop ${fmtPrice(p.stop)} · calidad ${p.quality}/10${rtTxt} — clic para ver el gráfico`;
  const enZona = rt && rt.state !== 'waiting';
  const cls = `pat-badge ${isW ? 'pat-w' : 'pat-m'}${p.state === 'breaking' || enZona ? ' pat-breaking' : ''}${p.state === 'forming' || p.state === 'confirming' ? ' pat-dim' : ''}`;
  const tfTag = tf === '15m' ? '' : `<span class="pat-tf">${tf}</span>`; // 15m es el implícito
  const suffix = enZona ? '↩' : p.state === 'breaking' ? '⚡' : p.state === 'confirming' ? '⏳' : p.state === 'broken' ? '✓' : '';
  return `<span class="${cls}" title="${title}" onclick="event.stopPropagation();openDetail('${row.symbol}','${tf}')">${isW ? 'W' : 'M'}${tfTag}${suffix}</span>`;
}

function patternBadge(row) {
  return _patBadgeOne(row, row.pattern, '15m')
       + _patBadgeOne(row, row.pattern1h, '1h')
       + _patBadgeOne(row, row.pattern4h, '4h');
}

// ── Tira única de patrones W/M ──────────────────────────────────────────────
// Antes había una tira por temporalidad: tres filas para el mismo concepto, y
// cada una se salía de la pantalla por la derecha. Ahora es UNA, ordenada por lo
// que se puede HACER con cada patrón; la temporalidad va como etiqueta dentro
// del chip, que es donde ocupa casi nada.
//
// Y se quita el relleno. Midiendo una pantalla real: de 13 chips en la fila de
// 4h solo 5 eran accionables, y el resto eran patrones con el cuello a +17,57%,
// +9,06%, +4,06%... o sea, cosas que no vas a operar hoy ocupando el ancho que
// necesitan las que sí. Esos patrones no se pierden: siguen en su badge junto al
// símbolo y en el panel de detalle.
//
// El corte se mide en ATR y no en un % fijo, igual que el resto del detector: un
// 2% es estar pegado al cuello en BTC y estar lejísimos en una moneda fina.
const STRIP_FORMING_ATR   = 0.6;  // 'formándose' entra solo si el cuello está a ≤0,6 ATR
const STRIP_BROKEN_ATR    = 3;    // 'roto' entra solo si el retroceso al cuello aún es plausible
const STRIP_MAX_COLLAPSED = 16;   // chips sin desplegar (~2 líneas en pantalla ancha)
const STRIP_MAX_TOTAL     = 40;   // tope duro con la tira desplegada

let _stripExpanded = false;
function togglePatternStrip() {
  _stripExpanded = !_stripExpanded;
  if (typeof allRows !== 'undefined' && allRows.length) renderPatternStrip(allRows);
}

// Orden de la tira: primero la NOTICIA, después el estado.
//
// La ruptura confirmada ocurre en un instante y caduca: una vez pasadas un par
// de velas ya no se opera igual, y si no la ves cuando pasa, la has perdido. El
// retroceso al cuello, en cambio, es una situación que se mantiene mientras el
// precio siga en la zona — sigue estando ahí dentro de diez minutos. Por eso
// manda la ruptura, aunque el retroceso sea la entrada más barata de ejecutar.
function _patUrgencia(p, rt) {
  if (p.state === 'breaking')       return 0;   // ⚡ ruptura confirmada por cierre
  if (rt && rt.state !== 'waiting') return 1;   // ↩ el precio está EN el cuello
  if (p.state === 'confirming')     return 2;   // ⏳ cruzando, falta el cierre
  if (p.state === 'forming')        return 3;   // formándose cerca del cuello
  return 4;                                     // roto, esperando que vuelva
}

function _patStripItems(rows) {
  const out = [];
  for (const r of rows) {
    for (const field of ['pattern', 'pattern1h', 'pattern4h']) {
      const p = r[field];
      if (!p || !r.price) continue;
      const rt = patRetest(p, r.price);
      const u = _patUrgencia(p, rt);
      // Un patrón aún sin romper solo interesa si el cuello está a tiro.
      if (u === 3) {
        if (!p.atr || Math.abs(p.neckline - r.price) > STRIP_FORMING_ATR * p.atr) continue;
      }
      // Uno ya roto solo interesa mientras el retroceso siga siendo creíble: si
      // el precio se fue 3 ATR, esa orden límite no se va a llenar.
      if (u === 4) {
        if (!rt || !p.atr || rt.dist > STRIP_BROKEN_ATR * p.atr) continue;
      }
      out.push({ r, p, rt, u });
    }
  }
  // Dentro de las rupturas confirmadas manda la MÁS RECIENTE, no la de más
  // calidad: el objetivo aquí es enterarse cuanto antes, y una ruptura de hace
  // 20 minutos ya no es una noticia por muy bonito que sea el patrón. En el
  // resto de grupos, donde no hay nada que caduque, sigue mandando la calidad.
  out.sort((a, b) => {
    if (a.u !== b.u) return a.u - b.u;
    if (a.u === 0) return (b.p.breakAt || 0) - (a.p.breakAt || 0);
    return b.p.quality - a.p.quality;
  });
  return out;
}

function renderPatternStrip(rows) {
  const el = document.getElementById('pattern-strip');
  if (!el) return;
  const items = _patStripItems(rows).slice(0, STRIP_MAX_TOTAL);
  if (!items.length) { el.innerHTML = ''; el.classList.remove('strip-ready'); return; }

  const nConf   = items.filter(x => x.u === 0).length;
  // Recién rota = la vela que rompió el cuello sigue siendo la última cerrada.
  // Es el mismo listón que usa el seguimiento en el Lab para dar una entrada por
  // buena, así que lo que se resalta aquí es exactamente lo que es operable.
  const nFresca = items.filter(x => x.u === 0 && x.p.barsSinceBreak === 0).length;
  const nCuello = items.filter(x => x.u === 1).length;
  const nCierre = items.filter(x => x.u === 2).length;

  const visibles = _stripExpanded ? items : items.slice(0, STRIP_MAX_COLLAPSED);
  const ocultos  = items.length - visibles.length;

  const chips = visibles.map(({ r, p, rt, u }) => {
    const isW = p.type === 'W';
    // Distancia al cuello con signo: >0 = el precio aún no ha llegado.
    const distPct = (p.neckline - r.price) / r.price * 100 * (isW ? 1 : -1);
    // Texto corto: el icono y el color ya dicen el estado, y el detalle completo
    // está en el tooltip. Antes cada chip repetía "EN EL CUELLO" entero.
    // Una ruptura recién confirmada -la vela de la ruptura aún es la última-
    // lleva marca propia: es LO que hay que ver cuanto antes.
    const fresca = u === 0 && p.barsSinceBreak === 0;
    const cuando = p.breakAt ? patAgo(Date.now() - p.breakAt).replace('hace ', '') : 'ahora';
    // Una ruptura puede tener ADEMÁS el precio de vuelta en el cuello: entonces
    // se dan las dos cosas, la noticia y el nivel al que poner la orden límite.
    const rtEnZona = rt && rt.state !== 'waiting';
    const estado =
        u === 0 ? `<b style="color:${fresca ? '#ffd76a' : '#ffbe3c'}">${fresca ? '🔴 ' : ''}⚡ ${cuando}</b>`
                  + (rtEnZona ? ` <b style="color:#7fd4ff">↩ ${fmtPrice(rt.level)}</b>`
                              : rt ? ` <span style="color:#7fd4ff">↩${rt.distPct.toFixed(1)}%</span>` : '')
      : u === 1 ? `<b style="color:#7fd4ff">↩ ${fmtPrice(rt.level)}</b>${rt.rr ? ` <span style="color:#2fe08a">${rt.rr.toFixed(1)}R</span>` : ''}`
      : u === 2 ? `<b style="color:#e0a830">⏳ cierre</b>`
      : u === 3 ? `<span style="color:#bbc2cd">${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%</span>`
      :           `<span style="color:#7fd4ff">↩${rt.distPct.toFixed(1)}%</span>`;

    const late = patLateness(p);
    const title = `${isW ? 'Doble suelo (W)' : 'Doble techo (M)'} en ${p.tf} · calidad ${p.quality}/10`
      + ` · cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)}`
      + (p.breakAt ? ` · rompió ${patAgo(Date.now() - p.breakAt)}${late ? ' (' + late.txt + ')' : ''}` : '')
      + (rt ? `\n↩ Orden límite en el cuello ${fmtPrice(rt.level)} · stop ${fmtPrice(rt.stop)}`
            + (rt.rr ? ` · R:R ${rt.rr.toFixed(1)}:1` : '')
            + (rt.state === 'waiting' ? ` — falta ${rt.distPct.toFixed(2)}% de retroceso` : ' — EL PRECIO ESTÁ AHÍ AHORA')
          : '');

    return `<span class="pat-chip${u <= 1 ? ' pat-breaking' : ''}" onclick="openDetail('${r.symbol}','${p.tf}')" title="${title}">
      ${r.symbol} <span class="pat-badge ${isW ? 'pat-w' : 'pat-m'}">${isW ? 'W' : 'M'}<span class="pat-tf">${p.tf}</span></span> ${estado}
    </span>`;
  }).join('');

  const masChip = ocultos > 0
    ? `<span class="pat-chip pat-chip-more" onclick="togglePatternStrip()" title="Los ${ocultos} restantes están ordenados por detrás: son los menos accionables de la lista">+${ocultos} más</span>`
    : (_stripExpanded && items.length > STRIP_MAX_COLLAPSED
        ? `<span class="pat-chip pat-chip-more" onclick="togglePatternStrip()">− menos</span>` : '');

  const resumen = [
    nConf   ? `<b style="color:#ffbe3c">${nConf} confirmada${nConf === 1 ? '' : 's'}</b>`
              + (nFresca ? ` <b style="color:#ffd76a">(${nFresca} recién)</b>` : '') : '',
    nCuello ? `<b style="color:#7fd4ff">${nCuello} en el cuello</b>` : '',
    nCierre ? `<span style="color:#e0a830">${nCierre} esperando cierre</span>` : '',
  ].filter(Boolean).join(' · ');

  el.innerHTML = `<span class="qal-head">◭ Patrones W/M${resumen ? ' — ' + resumen : ''}</span>${chips}${masChip}`;
  // El resaltado se enciende solo con rupturas RECIÉN confirmadas, no con que
  // haya confirmadas a secas: de esas hay casi siempre alguna entre las tres
  // temporalidades, y una tira encendida de forma permanente deja de avisar de
  // nada. Es estático a propósito, sin el parpadeo de .strip-hot: ese queda
  // reservado a momentum y outliers, donde sí es un evento raro.
  el.classList.toggle('strip-ready', nFresca > 0);
}
