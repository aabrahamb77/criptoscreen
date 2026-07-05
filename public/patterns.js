/* public/patterns.js
 * Detector de DOBLE SUELO (W) y DOBLE TECHO (M) con ruptura de línea de cuello.
 *
 * Método (sobre velas 15m, ~24h de historial — agregadas de las 5m en core.js):
 *  1. Pivotes: mínimo/máximo local = extremo de una ventana de ±2 velas (±30 min).
 *  2. Doble suelo: dos pivotes-mínimo casi al mismo precio (tolerancia en ATR,
 *     no en % fijo — comparable entre monedas), separados 4–40 velas (1–10h),
 *     con un rebote intermedio de profundidad ≥ 1 ATR. El máximo de ese rebote
 *     ES la línea de cuello. Doble techo = espejo.
 *  3. Estados:  formándose (aún bajo el cuello) → ROMPIENDO (cierre cruza el
 *     cuello en las últimas 2 velas → ALERTA) → roto/confirmado.
 *  4. Invalidación: si el precio perfora los suelos/techos, el patrón muere.
 *  5. Objetivo = cuello ± profundidad (movimiento medido) · stop = extremos ∓ 0.3 ATR.
 */

const PATTERN_CFG = {
  pivotWin:     2,     // pivote = extremo de ±2 velas 15m (30 min a cada lado)
  tolExtremes:  0.35,  // |suelo1 − suelo2| ≤ 0.35 × ATR(15m)
  minDepth:     1.0,   // profundidad valle→cuello ≥ 1 × ATR(15m)
  minSep:       4,     // separación mínima entre extremos (velas 15m = 1h)
  maxSep:       40,    // separación máxima (= 10h)
  maxAge2nd:    16,    // el 2º extremo debe estar en las últimas 16 velas (4h)
  breakWindow:  2,     // "ROMPIENDO" = cruce del cuello en las últimas 2 velas (30 min)
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

// ATR simple de velas 15m (true range medio de las últimas 40)
function _patAtr(k) {
  const n = k.c.length;
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, n - 40); i < n; i++) {
    sum += Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1]));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// ── Detección del mejor patrón vigente para una fila del screener ───────────
function detectDoublePattern(row) {
  const k = row.k15;
  if (!k || k.c.length < 30) return null;
  const n = k.c.length;
  const atr = _patAtr(k);
  if (!atr) return null;

  const piv   = _patPivots(k, PATTERN_CFG.pivotWin);
  const lows  = piv.filter(p => p.type === 'L');
  const highs = piv.filter(p => p.type === 'H');
  const last  = k.c[n - 1];
  const C = PATTERN_CFG;

  const scan = (exts, mids, isBottom) => {
    let best = null;
    const rank = c => (c.state === 'breaking' ? 2000 : c.state === 'forming' ? 1000 : 0) + c.p2.i;
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

        // Estado respecto al cuello
        const neckP = neck.price;
        const crossedAt = [];
        for (let i = P2.i + 1; i < n; i++) {
          const c0 = k.c[i - 1], c1 = k.c[i];
          if (isBottom ? (c1 > neckP && c0 <= neckP) : (c1 < neckP && c0 >= neckP)) crossedAt.push(i);
        }
        const lastCross = crossedAt.length ? crossedAt[crossedAt.length - 1] : null;
        const beyond = isBottom ? last > neckP : last < neckP;
        let state = 'forming';
        if (lastCross != null && n - 1 - lastCross < C.breakWindow && beyond) state = 'breaking';
        else if (beyond) state = 'broken';
        else if (lastCross != null) state = 'forming'; // cruzó pero volvió bajo el cuello (fakeout)

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
          state, quality,
          neckline: neckP, neckIdx: neck.i,
          p1: P1, p2: P2, depth, atr15m: atr,
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
    const pr = c => (c.state === 'breaking' ? 2 : c.state === 'forming' ? 1 : 0);
    return pr(W) !== pr(M) ? (pr(W) > pr(M) ? W : M) : (W.p2.i >= M.p2.i ? W : M);
  }
  return W || M;
}

// ── Escaneo por ciclo + alertas de ruptura de cuello ────────────────────────
const _patPrevState = new Map(); // sym → 'W:breaking' etc. (transiciones)
const _patAlertAt   = new Map(); // sym|type → ts de la última alerta (cooldown 30m)

function scanPatterns(rows) {
  const breakingEntries = []; // símbolos con cuello rompiéndose AHORA (para seguimiento/Comparador)
  for (const r of rows) {
    r.pattern = detectDoublePattern(r);
    const p = r.pattern;
    const cur = p ? p.type + ':' + p.state : null;
    const prev = _patPrevState.get(r.symbol);

    if (p && p.state === 'breaking') {
      const isW = p.type === 'W';
      breakingEntries.push({ symbol: r.symbol, side: isW ? 'l' : 's', score: p.quality });

      if (prev !== cur) {
        // Seguimiento hasta que se complete (sin límite de tiempo): abre una
        // entrada que solo se cierra al tocar el objetivo o el stop sugerido
        // por el propio patrón — ver checkPatternTrackOutcomes() en lab.js.
        if (typeof trackPatternSignal === 'function') trackPatternSignal(r, p);

        const key = r.symbol + '|' + p.type;
        const lastAlert = _patAlertAt.get(key) || 0;
        if (Date.now() - lastAlert > 30 * 60_000) {
          _patAlertAt.set(key, Date.now());
          showToast(`${isW ? '🟢 DOBLE SUELO' : '🔴 DOBLE TECHO'} ${r.symbol} — ¡rompiendo cuello ${fmtPrice(p.neckline)}!`, isW ? 'long' : 'short');
          if (soundEnabled) { beep(isW ? 1150 : 360, 'square', 200); setTimeout(() => beep(isW ? 1350 : 300, 'square', 200), 240); }
          notifyDesktop(
            `${isW ? '🟢 W' : '🔴 M'} ${r.symbol} — ruptura de línea de cuello`,
            `Cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · stop ${fmtPrice(p.stop)} · calidad ${p.quality}/10`
          );
        }
      }
    }
    _patPrevState.set(r.symbol, cur);
  }

  // Seguimiento primero (Comparador): registra la ruptura como señal, misma
  // vara que las otras 10 estrategias — n≥30 y WR≥55% antes de considerarla
  // operable. Se llama cada ciclo con el set actual "rompiendo ahora"; el
  // dedup de logPanelDetections evita re-registrar mientras siga activa.
  if (typeof logPanelDetections === 'function') logPanelDetections('patternWM', breakingEntries);

  // Resuelve objetivo/stop de los patrones en seguimiento — SIEMPRE, tenga o
  // no la pestaña Lab abierta (sin esto, un patrón que completa mientras ves
  // el Screener nunca se cerraría hasta volver al Lab).
  if (typeof checkPatternTrackOutcomes === 'function') checkPatternTrackOutcomes();

  renderPatternStrip(rows);
}

// ── Badge junto al símbolo en la tabla ──────────────────────────────────────
function patternBadge(row) {
  const p = row.pattern;
  if (!p) return '';
  const isW = p.type === 'W';
  const stateTxt = p.state === 'breaking' ? 'ROMPIENDO CUELLO' : p.state === 'forming' ? 'formándose' : 'cuello roto';
  const title = `${isW ? 'Doble suelo (W)' : 'Doble techo (M)'} — ${stateTxt} · cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · stop ${fmtPrice(p.stop)} · calidad ${p.quality}/10 — clic para ver el gráfico`;
  const cls = `pat-badge ${isW ? 'pat-w' : 'pat-m'}${p.state === 'breaking' ? ' pat-breaking' : ''}${p.state === 'forming' ? ' pat-dim' : ''}`;
  return `<span class="${cls}" title="${title}" onclick="event.stopPropagation();openDetail('${row.symbol}')">${isW ? 'W' : 'M'}${p.state === 'breaking' ? '⚡' : p.state === 'broken' ? '✓' : ''}</span>`;
}

// ── Strip de patrones bajo el mapa ──────────────────────────────────────────
function renderPatternStrip(rows) {
  const el = document.getElementById('pattern-strip');
  if (!el) return;
  const order = { breaking: 0, forming: 1, broken: 2 };
  const items = rows
    .filter(r => r.pattern)
    .sort((a, b) => order[a.pattern.state] - order[b.pattern.state] || b.pattern.quality - a.pattern.quality)
    .slice(0, 16);
  if (!items.length) { el.innerHTML = ''; return; }

  const breaking = items.filter(r => r.pattern.state === 'breaking').length;
  const chips = items.map(r => {
    const p = r.pattern;
    const isW = p.type === 'W';
    const distPct = (p.neckline - r.price) / r.price * 100 * (isW ? 1 : -1); // >0 = aún no llega al cuello
    const stateHtml = p.state === 'breaking'
      ? `<b style="color:#ffbe3c">⚡ ROMPIENDO</b>`
      : p.state === 'forming'
        ? `<span style="color:#5a6a85">cuello a ${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%</span>`
        : `<span style="color:${isW ? '#2fe08a' : '#ff6666'}">roto ${(-distPct).toFixed(2)}%</span>`;
    return `<span class="pat-chip${p.state === 'breaking' ? ' pat-breaking' : ''}" onclick="openDetail('${r.symbol}')"
      title="${isW ? 'Doble suelo' : 'Doble techo'} · cuello ${fmtPrice(p.neckline)} · objetivo ${fmtPrice(p.target)} · calidad ${p.quality}/10">
      ${r.symbol} <span class="pat-badge ${isW ? 'pat-w' : 'pat-m'}">${isW ? 'W' : 'M'}</span> ${stateHtml}
    </span>`;
  }).join('');

  el.innerHTML = `<span class="qal-head">◭ Patrones W/M${breaking ? ` — <b style="color:#ffbe3c">${breaking} rompiendo cuello</b>` : ''}</span>${chips}`;
}
