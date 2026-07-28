/* public/patterns.js
 * Detector de DOBLE SUELO (W) y DOBLE TECHO (M) con ruptura de línea de cuello,
 * en DOS temporalidades: velas 15m (~24h) y velas 1h (~50h).
 *
 * Método (idéntico en ambas TF, con parámetros propios):
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
  pivotWin:     2,     // pivote = extremo de ±2 velas (2h a cada lado)
  tolExtremes:  0.4,   // algo más tolerante: los extremos de 1h son más rugosos
  minDepth:     1.0,
  minSep:       3,     // 3h mínimo entre suelos
  maxSep:       30,    // hasta 30h (limitado por las ~50 velas disponibles)
  maxAge2nd:    10,    // el 2º extremo en las últimas 10 velas (10h)
  breakWindow:  2,     // cruce del cuello en las últimas 2 velas (2h)
};

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
  if (!k || k.c.length < (C.tf === '1h' ? 20 : 30)) return null;
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

// Mejor patrón vigente por fila del screener, en cada temporalidad
function detectDoublePattern(row)   { return _detectDouble(row.k15, PATTERN_CFG); }
function detectDoublePattern1h(row) { return _detectDouble(row.k60, PATTERN_CFG_1H); }

// ── Escaneo por ciclo + alertas de ruptura de cuello ────────────────────────
const _patPrevState = new Map(); // sym|tf → 'W:breaking' etc. (transiciones)
const _patAlertAt   = new Map(); // sym|type|tf → ts de la última alerta (cooldown)

function _patAlerts(r, p, tf, breakingEntries) {
  if (!p) { _patPrevState.set(r.symbol + '|' + tf, null); return; }
  const cur = p.type + ':' + p.state;
  const prev = _patPrevState.get(r.symbol + '|' + tf);

  if (p.state === 'breaking') {
    const isW = p.type === 'W';
    breakingEntries.push({ symbol: r.symbol, side: isW ? 'l' : 's', score: p.quality });

    if (prev !== cur) {
      // Seguimiento hasta que se complete (objetivo o stop) — ver lab.js
      if (typeof trackPatternSignal === 'function') trackPatternSignal(r, p);

      const key = r.symbol + '|' + p.type + '|' + tf;
      const lastAlert = _patAlertAt.get(key) || 0;
      // cooldown mayor en 1h (las velas duran más, la misma ruptura persiste)
      const cooldown = tf === '1h' ? 2 * 3600_000 : 30 * 60_000;
      if (canAlert(tf === '1h' ? 'pattern1h' : 'pattern15') && Date.now() - lastAlert > cooldown) {
        _patAlertAt.set(key, Date.now());
        const tfTag = tf === '1h' ? ' (1h)' : ' (15m)';
        showToast(`${isW ? '🟢 DOBLE SUELO' : '🔴 DOBLE TECHO'}${tfTag} ${r.symbol} — ¡ruptura de cuello CONFIRMADA con cierre de vela!`, isW ? 'long' : 'short');
        if (soundEnabled) { beep(isW ? 1150 : 360, 'square', 200); setTimeout(() => beep(isW ? 1350 : 300, 'square', 200), 240); }
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
  for (const r of rows) {
    r.pattern   = detectDoublePattern(r);
    r.pattern1h = detectDoublePattern1h(r);
    _patAlerts(r, r.pattern,   '15m', breaking15);
    _patAlerts(r, r.pattern1h, '1h',  breaking1h);
  }

  // Comparador: cada TF acumula su PROPIA evidencia (misma vara que las demás
  // estrategias: n≥30 y WR≥55% antes de considerarla operable).
  if (typeof logPanelDetections === 'function') {
    logPanelDetections('patternWM', breaking15);
    logPanelDetections('patternWM1h', breaking1h);
  }

  // Resuelve objetivo/stop de los patrones en seguimiento — SIEMPRE, tenga o
  // no la pestaña Lab abierta.
  if (typeof checkPatternTrackOutcomes === 'function') checkPatternTrackOutcomes();

  renderPatternStrip(rows);
}

// ── Badges junto al símbolo en la tabla (uno por temporalidad) ──────────────
function _patBadgeOne(row, p, tf) {
  if (!p) return '';
  const isW = p.type === 'W';
  const stateTxt = p.state === 'breaking' ? 'RUPTURA CONFIRMADA (cierre de vela ' + tf + ')'
                 : p.state === 'confirming' ? 'cruzando el cuello — ESPERANDO CIERRE de vela ' + tf
                 : p.state === 'forming' ? 'formándose' : 'cuello roto';
  const title = `${isW ? 'Doble suelo (W)' : 'Doble techo (M)'} en ${tf} — ${stateTxt} · cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · stop ${fmtPrice(p.stop)} · calidad ${p.quality}/10 — clic para ver el gráfico`;
  const cls = `pat-badge ${isW ? 'pat-w' : 'pat-m'}${p.state === 'breaking' ? ' pat-breaking' : ''}${p.state === 'forming' || p.state === 'confirming' ? ' pat-dim' : ''}`;
  const tfTag = tf === '1h' ? '<span class="pat-tf">1h</span>' : '';
  const suffix = p.state === 'breaking' ? '⚡' : p.state === 'confirming' ? '⏳' : p.state === 'broken' ? '✓' : '';
  return `<span class="${cls}" title="${title}" onclick="event.stopPropagation();openDetail('${row.symbol}')">${isW ? 'W' : 'M'}${tfTag}${suffix}</span>`;
}

function patternBadge(row) {
  return _patBadgeOne(row, row.pattern, '15m') + _patBadgeOne(row, row.pattern1h, '1h');
}

// ── Strips bajo el mapa: 15m arriba, 1h justo debajo ────────────────────────
function _patStripInto(elId, rows, field, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  const order = { breaking: 0, confirming: 1, forming: 2, broken: 3 };
  const items = rows
    .filter(r => r[field])
    .sort((a, b) => order[a[field].state] - order[b[field].state] || b[field].quality - a[field].quality)
    .slice(0, 16);
  if (!items.length) { el.innerHTML = ''; return; }

  const breaking = items.filter(r => r[field].state === 'breaking').length;
  const chips = items.map(r => {
    const p = r[field];
    const isW = p.type === 'W';
    const distPct = (p.neckline - r.price) / r.price * 100 * (isW ? 1 : -1); // >0 = aún no llega al cuello
    const stateHtml = p.state === 'breaking'
      ? `<b style="color:#ffbe3c">⚡ CONFIRMADA</b>`
      : p.state === 'confirming'
        ? `<b style="color:#e0a830">⏳ esperando cierre</b>`
        : p.state === 'forming'
          ? `<span style="color:#5a6a85">cuello a ${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%</span>`
          : `<span style="color:${isW ? '#2fe08a' : '#ff6666'}">roto ${(-distPct).toFixed(2)}%</span>`;
    return `<span class="pat-chip${p.state === 'breaking' ? ' pat-breaking' : ''}" onclick="openDetail('${r.symbol}')"
      title="${isW ? 'Doble suelo' : 'Doble techo'} (${p.tf}) · cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · calidad ${p.quality}/10">
      ${r.symbol} <span class="pat-badge ${isW ? 'pat-w' : 'pat-m'}">${isW ? 'W' : 'M'}</span> ${stateHtml}
    </span>`;
  }).join('');

  el.innerHTML = `<span class="qal-head">${label}${breaking ? ` — <b style="color:#ffbe3c">${breaking} rompiendo cuello</b>` : ''}</span>${chips}`;
}

function renderPatternStrip(rows) {
  _patStripInto('pattern-strip',    rows, 'pattern',   '◭ Patrones W/M 15m');
  _patStripInto('pattern-strip-1h', rows, 'pattern1h', '◭ Patrones W/M 1h');
}
