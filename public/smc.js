/* public/smc.js
 * Smart Money Concepts (SMC) para BTC — v2 mejorada:
 *
 *  · Estructura DUAL: mayor (swings de ±8 velas, chips BOS/CHoCH bien visibles)
 *    e interna (±3 velas, marcas discretas sin texto). Antes todo pesaba igual
 *    y el gráfico se llenaba de chips encimados sin jerarquía.
 *  · Filtro de significancia: una ruptura solo cuenta si el cierre supera el
 *    nivel por ≥0.1×ATR — elimina los micro-BOS de ruido.
 *  · Order blocks SOLO de estructura mayor, y los VIOLADOS (cierre atraviesa
 *    la zona entera tras mitigar) se dejan de dibujar: si no respetó la zona,
 *    ya no es información.
 *  · FVG: solo se dibujan los de tamaño ≥0.15×ATR (los micro-huecos no operan).
 *  · Equilibrium del rango mayor vigente: línea EQ 50% + sombreado sutil
 *    premium (arriba, vender caro) / discount (abajo, comprar barato).
 *  · Chips con anti-solape: si dos etiquetas caen en el mismo sitio se apilan.
 *
 * Se calcula sobre las velas 15m de BTC (btcChartData(); reutiliza
 * _patPivots/_patAtr de patterns.js — cargar DESPUÉS de patterns.js y ANTES
 * de btc.js). Aporta el factor "Estructura SMC" a la confluencia de sesgo.
 *
 * Nota de honestidad: los pivotes se confirman con N velas de "mirada atrás";
 * es contexto estructural, no señal de entrada en tiempo real.
 */

const SMC_WIN_MAJOR   = 8;    // swings mayores: ±8 velas 15m (~2h por lado)
const SMC_WIN_INT     = 3;    // swings internos: ±3 velas
const SMC_MAX_MAJOR   = 6;    // últimos BOS/CHoCH mayores conservados
const SMC_MAX_INT     = 8;    // últimos internos (se dibujan discretos)
const SMC_MAX_FVG     = 20;
const SMC_OB_LOOKBACK = 12;
const SMC_BREAK_BUF   = 0.10; // ×ATR: margen mínimo para validar una ruptura
const SMC_FVG_MIN     = 0.15; // ×ATR: alto mínimo de un FVG para dibujarlo

// ── Estructura: swings confirmados → BOS (continuación) / CHoCH (giro) ──────
// `win` controla la escala; `buf` (en precio) filtra rupturas insignificantes.
function smcStructure(k, win, buf) {
  const piv = _patPivots(k, win);
  if (piv.length < 2) return { events: [], trend: 'NEUTRAL' };
  const pivByIdx = new Map(piv.map(p => [p.i, p]));

  const events = [];
  let trend = null;
  let curHighRef = null, curLowRef = null;
  for (let i = 0; i < k.c.length; i++) {
    const p = pivByIdx.get(i);
    if (p) { if (p.type === 'H') curHighRef = p; else curLowRef = p; }
    if (curHighRef && i > curHighRef.i && k.c[i] > curHighRef.price + buf) {
      events.push({ i, price: curHighRef.price, fromI: curHighRef.i, dir: 'up',
        type: trend === 'down' ? 'CHoCH' : 'BOS' });
      trend = 'up'; curHighRef = null;
    }
    if (curLowRef && i > curLowRef.i && k.c[i] < curLowRef.price - buf) {
      events.push({ i, price: curLowRef.price, fromI: curLowRef.i, dir: 'down',
        type: trend === 'up' ? 'CHoCH' : 'BOS' });
      trend = 'down'; curLowRef = null;
    }
  }
  return { events, trend: trend || 'NEUTRAL', pivots: piv };
}

// ── Order blocks: última vela opuesta al impulso antes de cada ruptura MAYOR ─
function smcOrderBlocks(k, events) {
  const seen = new Map();
  for (const e of events) {
    const bullish = e.dir === 'up';
    let obIdx = -1;
    for (let j = e.i; j >= Math.max(0, e.i - SMC_OB_LOOKBACK); j--) {
      const down = k.c[j] < k.o[j];
      if (bullish && down)  { obIdx = j; break; }
      if (!bullish && !down) { obIdx = j; break; }
    }
    if (obIdx < 0) continue;
    const ob = { i: obIdx, dir: bullish ? 'bull' : 'bear',
      top: k.h[obIdx], bottom: k.l[obIdx], breakIdx: e.i, kind: e.type };
    // Mitigación: primer retorno del precio a la zona tras la ruptura.
    // Violación: tras mitigar, un CIERRE atraviesa la zona completa — el OB
    // falló y deja de ser información (se descarta al dibujar).
    for (let j = e.i + 1; j < k.c.length; j++) {
      if (ob.mitigatedIdx == null) {
        if (k.l[j] <= ob.top && k.h[j] >= ob.bottom) ob.mitigatedIdx = j;
      } else {
        if (ob.dir === 'bull' ? k.c[j] < ob.bottom : k.c[j] > ob.top) { ob.violatedIdx = j; break; }
      }
    }
    seen.set(obIdx, ob);
  }
  return [...seen.values()].sort((a, b) => a.i - b.i);
}

// ── Fair Value Gaps: hueco de 3 velas (imbalance) sin rellenar ──────────────
function smcFVGs(k) {
  const n = k.c.length;
  const start = Math.max(1, n - 400);
  const gaps = [];
  for (let i = start; i < n - 1; i++) {
    if (k.l[i + 1] > k.h[i - 1])      gaps.push({ i, dir: 'bull', top: k.l[i + 1], bottom: k.h[i - 1] });
    else if (k.h[i + 1] < k.l[i - 1]) gaps.push({ i, dir: 'bear', top: k.l[i - 1], bottom: k.h[i + 1] });
  }
  for (const g of gaps) {
    for (let j = g.i + 2; j < n; j++) {
      if (k.l[j] <= g.top && k.h[j] >= g.bottom) { g.filledIdx = j; break; }
    }
  }
  return gaps.slice(-SMC_MAX_FVG);
}

// ── Equilibrium: rango entre el último swing high y low MAYORES ─────────────
// posPct > 50% = premium (zona de vender) · < 50% = discount (zona de comprar)
function smcEquilibrium(k, majorPivots) {
  if (!majorPivots?.length) return null;
  const lastH = [...majorPivots].reverse().find(p => p.type === 'H');
  const lastL = [...majorPivots].reverse().find(p => p.type === 'L');
  if (!lastH || !lastL || lastH.price <= lastL.price) return null;
  const last = k.c[k.c.length - 1];
  const posPct = (last - lastL.price) / (lastH.price - lastL.price) * 100;
  return { hi: lastH.price, lo: lastL.price, mid: (lastH.price + lastL.price) / 2,
    fromI: Math.min(lastH.i, lastL.i), posPct };
}

// ── Temporalidad del análisis SMC: 15m (nativa del gráfico) o 1h ────────────
// En 1h las velas 15m se agregan a horas, TODO el análisis (estructura, OB,
// FVG, equilibrium) corre sobre esas velas y los índices se re-mapean a las
// velas 15m del gráfico para dibujarse — igual que un indicador multi-TF de
// TradingView. La estructura 1h es más lenta pero mucho más fiable.
let _btcSmcTf = localStorage.getItem('scalp_btc_smc_tf') === '1h' ? '1h' : '15m';

function btcToggleSMCTf() {
  _btcSmcTf = _btcSmcTf === '15m' ? '1h' : '15m';
  safeSetItem('scalp_btc_smc_tf', _btcSmcTf);
  btcComputeSMC();
  const row = allRows.find(r => r.symbol === 'BTC');
  if (row) drawBTCChart(row);
  const btn = document.getElementById('btc-smc-tf-btn');
  if (btn) { btn.textContent = '⏱ ' + _btcSmcTf; btn.classList.toggle('active', _btcSmcTf === '1h'); }
}

// Agrega velas 15m → 1h. Devuelve también el mapeo de índices 1h→15m
// (startIdx/endIdx de cada hora) para poder dibujar sobre el gráfico 15m.
function _smcAggregate1h(k) {
  const a = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const startIdx = [], endIdx = [];
  let curHour = null;
  for (let i = 0; i < k.c.length; i++) {
    const hb = Math.floor(k.t[i] / 3600_000);
    if (hb !== curHour) {
      curHour = hb;
      a.t.push(k.t[i]); a.o.push(k.o[i]); a.h.push(k.h[i]);
      a.l.push(k.l[i]); a.c.push(k.c[i]); a.v.push(k.v[i]);
      startIdx.push(i); endIdx.push(i);
    } else {
      const j = a.c.length - 1;
      a.h[j] = Math.max(a.h[j], k.h[i]);
      a.l[j] = Math.min(a.l[j], k.l[i]);
      a.c[j] = k.c[i]; a.v[j] += k.v[i];
      endIdx[j] = i;
    }
  }
  return { a, startIdx, endIdx };
}

// ── Cálculo principal: una vez por ciclo desde btcComputeFactors ────────────
function btcComputeSMC() {
  const k15 = btcChartData();
  if (!k15 || k15.c.length < 40) { BTC.smc = null; return; }

  // Velas de análisis según temporalidad elegida
  let k = k15, mapS = null, mapE = null;
  if (_btcSmcTf === '1h') {
    const { a, startIdx, endIdx } = _smcAggregate1h(k15);
    if (a.c.length >= 40) { k = a; mapS = startIdx; mapE = endIdx; }
  }

  const atr = _patAtr(k) || 0;
  const buf = atr * SMC_BREAK_BUF;
  const major    = smcStructure(k, SMC_WIN_MAJOR, buf);
  const internal = smcStructure(k, SMC_WIN_INT, buf);
  const obs  = smcOrderBlocks(k, major.events.slice(-SMC_MAX_MAJOR));
  const fvgs = smcFVGs(k);
  const eq   = smcEquilibrium(k, major.pivots);

  // Re-mapeo de índices 1h → 15m para el dibujo y el factor de sesgo
  // (inicio de la hora para zonas/pivotes, fin de la hora para rupturas/cierres)
  if (mapE) {
    const mS = i => mapS[Math.max(0, Math.min(i, mapS.length - 1))];
    const mE = i => mapE[Math.max(0, Math.min(i, mapE.length - 1))];
    for (const arr of [major.events, internal.events]) {
      for (const e of arr) { e.i = mE(e.i); e.fromI = mS(e.fromI); }
    }
    for (const o of obs) {
      o.i = mS(o.i); o.breakIdx = mE(o.breakIdx);
      if (o.mitigatedIdx != null) o.mitigatedIdx = mE(o.mitigatedIdx);
      if (o.violatedIdx != null)  o.violatedIdx  = mE(o.violatedIdx);
    }
    for (const g of fvgs) {
      g.i = mS(g.i);
      if (g.filledIdx != null) g.filledIdx = mE(g.filledIdx);
    }
    if (eq) eq.fromI = mS(eq.fromI);
  }

  BTC.smc = {
    atr, tf: _btcSmcTf,
    major:    { events: major.events.slice(-SMC_MAX_MAJOR), trend: major.trend },
    internal: { events: internal.events.slice(-SMC_MAX_INT), trend: internal.trend },
    obs, fvgs, eq,
    // compat: consumidores viejos leen .events/.trend → apuntan a la estructura mayor
    events: major.events.slice(-SMC_MAX_MAJOR), trend: major.trend,
  };
}

// ── Toggle de visibilidad del overlay (persistido) ──────────────────────────
let _btcSmcOn = localStorage.getItem('scalp_btc_smc') !== '0';
function btcToggleSMC() {
  _btcSmcOn = !_btcSmcOn;
  safeSetItem('scalp_btc_smc', _btcSmcOn ? '1' : '0');
  const btn = document.getElementById('btc-smc-btn');
  if (btn) btn.classList.toggle('active', _btcSmcOn);
  const row = allRows.find(r => r.symbol === 'BTC');
  if (row) drawBTCChart(row);
}

// ── Dibujo. smcDrawZones va ANTES de las velas (zonas al fondo);
// smcDrawStructure DESPUÉS (etiquetas encima). Ambas (ctx, x, y, s0, s1). ────
let _smcChipRects = []; // rects de chips ya colocados en este frame (anti-solape)

function smcDrawZones(ctx, x, y, s0, s1) {
  _smcChipRects = []; // primer hook del frame: resetea el anti-solape
  if (!_btcSmcOn || !BTC.smc) return;
  const atr = BTC.smc.atr || 0;

  // Premium/discount del rango mayor vigente (muy sutil, al fondo del todo)
  const eq = BTC.smc.eq;
  if (eq && eq.fromI < s1) {
    const xa = x(Math.max(s0, eq.fromI)), xb = x(s1 - 1);
    const yHi = y(eq.hi), yMid = y(eq.mid), yLo = y(eq.lo);
    ctx.fillStyle = 'rgba(255,102,102,0.035)'; // premium: mitad superior
    ctx.fillRect(xa, Math.min(yHi, yMid), xb - xa, Math.abs(yMid - yHi));
    ctx.fillStyle = 'rgba(47,224,138,0.035)';  // discount: mitad inferior
    ctx.fillRect(xa, Math.min(yMid, yLo), xb - xa, Math.abs(yLo - yMid));
    ctx.save();
    ctx.strokeStyle = '#8aa0c8'; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(xa, yMid); ctx.lineTo(xb, yMid); ctx.stroke();
    ctx.restore();
    _smcChip(ctx, `EQ 50% · ${eq.posPct >= 50 ? 'premium' : 'discount'} ${eq.posPct.toFixed(0)}%`,
      xa + 60, yMid - 7, '#8aa0c8');
  }

  // FVG (solo los de tamaño operable, más tenues que los OB)
  for (const g of (BTC.smc.fvgs || [])) {
    if (atr && (g.top - g.bottom) < SMC_FVG_MIN * atr) continue; // micro-hueco: ruido
    const endI = g.filledIdx ?? (s1 - 1);
    if (endI < s0 || g.i - 1 >= s1) continue;
    const xa = x(Math.max(s0, g.i - 1)), xb = x(Math.min(s1 - 1, endI));
    const ya = y(g.top), yb = y(g.bottom);
    ctx.fillStyle = g.dir === 'bull' ? 'rgba(47,224,138,0.09)' : 'rgba(255,102,102,0.09)';
    ctx.fillRect(xa, Math.min(ya, yb), Math.max(2, xb - xa), Math.max(1, Math.abs(yb - ya)));
  }

  // Order blocks (solo de estructura mayor; los violados no se dibujan)
  const OB_MIN_H = 10; // px
  for (const o of (BTC.smc.obs || [])) {
    if (o.violatedIdx != null) continue; // el precio lo atravesó: zona muerta
    const endI = o.mitigatedIdx ?? (s1 - 1);
    if (endI < s0 || o.i >= s1) continue;
    const xa = x(Math.max(s0, o.i)), xb = x(Math.min(s1 - 1, endI));
    let ya = y(o.top), yb = y(o.bottom);
    if (Math.abs(yb - ya) < OB_MIN_H) {
      const cy = (ya + yb) / 2;
      ya = cy - OB_MIN_H / 2; yb = cy + OB_MIN_H / 2;
    }
    const top = Math.min(ya, yb), h = Math.max(OB_MIN_H, Math.abs(yb - ya));
    const w = Math.max(3, xb - xa);
    const col = o.dir === 'bull' ? '#2fe08a' : '#ff6666';
    const active = o.mitigatedIdx == null;
    ctx.save();
    ctx.fillStyle = o.dir === 'bull'
      ? `rgba(47,224,138,${active ? 0.28 : 0.14})`
      : `rgba(255,102,102,${active ? 0.28 : 0.14})`;
    ctx.fillRect(xa, top, w, h);
    ctx.strokeStyle = col; ctx.globalAlpha = active ? 0.9 : 0.4; ctx.lineWidth = active ? 1.6 : 1;
    ctx.setLineDash(active ? [] : [3, 2]); // sólida = intacta · punteada = mitigada (reaccionó)
    if (active) { ctx.shadowColor = col; ctx.shadowBlur = 4; }
    ctx.strokeRect(xa, top, w, h);
    ctx.restore();
    _smcChip(ctx, active ? 'OB' : 'OB ✓', xa + 15, top + h / 2 - 7, col);
  }
}

// Chip con fondo sólido + ANTI-SOLAPE: si el rect choca con un chip ya puesto,
// se desplaza en vertical (hasta 4 saltos) buscando hueco libre.
const SMC_TEXT_COL = '#eef4ff';
function _smcChip(ctx, txt, cx, topY, borderCol) {
  ctx.font = '800 9.5px Inter,system-ui'; ctx.textAlign = 'center';
  const tw = ctx.measureText(txt).width;
  const w = tw + 10, h = 14;
  const x0 = cx - w / 2;
  const collides = ty => _smcChipRects.some(r =>
    x0 < r.x + r.w && x0 + w > r.x && ty < r.y + r.h + 2 && ty + h > r.y - 2);
  let ty = topY, tries = 0;
  while (collides(ty) && tries < 4) { ty += (tries % 2 === 0 ? 1 : -1) * (16 * (tries + 1)); tries++; }
  _smcChipRects.push({ x: x0, y: ty, w, h });
  ctx.fillStyle = 'rgba(6,9,14,0.95)';
  ctx.fillRect(x0, ty, w, h);
  ctx.strokeStyle = borderCol; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.1;
  ctx.strokeRect(x0, ty, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = SMC_TEXT_COL;
  ctx.fillText(txt, cx, ty + h - 4);
}

function smcDrawStructure(ctx, x, y, s0, s1) {
  if (!_btcSmcOn || !BTC.smc) return;

  // Estructura interna: discreta — línea finísima + triángulo, SIN texto
  for (const e of (BTC.smc.internal?.events || [])) {
    if (e.i < s0 || e.i >= s1) continue;
    const col = e.dir === 'up' ? '#2fe08a' : '#ff6666';
    const x0 = x(Math.max(s0, e.fromI)), x1 = x(e.i);
    const ly = y(e.price);
    ctx.save();
    ctx.strokeStyle = col; ctx.globalAlpha = 0.28; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x0, ly); ctx.lineTo(x1, ly); ctx.stroke();
    ctx.globalAlpha = 0.6; ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.beginPath(); // triángulo pequeño apuntando en la dirección de la ruptura
    if (e.dir === 'up') { ctx.moveTo(x1, ly - 6); ctx.lineTo(x1 - 3.5, ly - 1); ctx.lineTo(x1 + 3.5, ly - 1); }
    else                { ctx.moveTo(x1, ly + 6); ctx.lineTo(x1 - 3.5, ly + 1); ctx.lineTo(x1 + 3.5, ly + 1); }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Estructura mayor: línea marcada + chip BOS/CHoCH (con anti-solape)
  for (const e of (BTC.smc.major?.events || [])) {
    if (e.i < s0 || e.i >= s1) continue;
    const lineCol = e.dir === 'up' ? '#2fe08a' : '#ff6666';
    const x0 = x(Math.max(s0, e.fromI)), x1 = x(e.i);
    const ly = y(e.price);
    ctx.save();
    ctx.strokeStyle = lineCol; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x0, ly); ctx.lineTo(x1, ly); ctx.stroke();
    ctx.restore();
    const txt = `${e.type} ${e.dir === 'up' ? '▲' : '▼'}`;
    const chipY = e.dir === 'up' ? ly - 22 : ly + 8;
    _smcChip(ctx, txt, x1, chipY, lineCol);
  }
}
