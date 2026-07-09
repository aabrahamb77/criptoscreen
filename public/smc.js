/* public/smc.js
 * Smart Money Concepts (SMC) para BTC: estructura de mercado (BOS/CHoCH),
 * order blocks y fair value gaps (FVG).
 *
 * Se calculan sobre las velas 15m de BTC (btcChartData(), reutiliza
 * _patPivots/_patAtr de patterns.js — por eso este archivo debe cargarse
 * DESPUÉS de patterns.js y ANTES de btc.js) y se dibujan como overlay en el
 * gráfico de la pestaña ₿, además de aportar un factor más a la confluencia
 * de sesgo (btcComputeFactors, en btc.js).
 *
 * Nota de honestidad: al igual que el detector de patrones W/M, esto usa
 * pivotes confirmados con SMC_SWING_WIN velas de "mirada atrás" — es un
 * overlay de CONTEXTO estructural, no una señal de entrada en tiempo real
 * (el swing más reciente tarda esas velas en confirmarse).
 */

const SMC_SWING_WIN  = 3;   // velas a cada lado para confirmar un swing (topes/suelos)
const SMC_MAX_EVENTS = 8;   // estructura: solo se conservan los últimos N BOS/CHoCH
const SMC_MAX_FVG    = 20;  // FVG recientes evaluados (luego se filtran los visibles al dibujar)
const SMC_OB_LOOKBACK = 12; // velas hacia atrás para buscar la vela de order block de un impulso

// ── Estructura: swings confirmados → secuencia BOS (a favor de la tendencia
// vigente) / CHoCH (en contra = posible cambio de carácter/giro) ───────────
function smcStructure(k) {
  const piv = _patPivots(k, SMC_SWING_WIN);
  if (piv.length < 2) return { events: [], trend: 'NEUTRAL' };
  const pivByIdx = new Map(piv.map(p => [p.i, p]));

  const events = [];
  let trend = null;
  let curHighRef = null, curLowRef = null;
  for (let i = 0; i < k.c.length; i++) {
    const p = pivByIdx.get(i);
    if (p) { if (p.type === 'H') curHighRef = p; else curLowRef = p; }
    // ruptura alcista: el cierre supera el último swing high de referencia
    if (curHighRef && i > curHighRef.i && k.c[i] > curHighRef.price) {
      events.push({ i, price: curHighRef.price, fromI: curHighRef.i, dir: 'up',
        type: trend === 'down' ? 'CHoCH' : 'BOS' });
      trend = 'up'; curHighRef = null;
    }
    // ruptura bajista: el cierre perfora el último swing low de referencia
    if (curLowRef && i > curLowRef.i && k.c[i] < curLowRef.price) {
      events.push({ i, price: curLowRef.price, fromI: curLowRef.i, dir: 'down',
        type: trend === 'up' ? 'CHoCH' : 'BOS' });
      trend = 'down'; curLowRef = null;
    }
  }
  return { events: events.slice(-SMC_MAX_EVENTS), trend: trend || 'NEUTRAL' };
}

// ── Order blocks: última vela opuesta al impulso justo antes de cada ruptura
// de estructura (el candidato clásico a "dinero inteligente" posicionándose
// antes del movimiento fuerte) ──────────────────────────────────────────────
function smcOrderBlocks(k, events) {
  const seen = new Map(); // dedupe por índice: rupturas seguidas pueden compartir el mismo OB
  for (const e of events) {
    const bullish = e.dir === 'up';
    let obIdx = -1;
    for (let j = e.i; j >= Math.max(0, e.i - SMC_OB_LOOKBACK); j--) {
      const down = k.c[j] < k.o[j];
      if (bullish && down)  { obIdx = j; break; } // último rojo antes del impulso alcista
      if (!bullish && !down) { obIdx = j; break; } // última verde antes del impulso bajista
    }
    if (obIdx < 0) continue;
    const ob = { i: obIdx, dir: bullish ? 'bull' : 'bear',
      top: k.h[obIdx], bottom: k.l[obIdx], breakIdx: e.i, kind: e.type };
    // Mitigación: primera vez que el precio VUELVE a tocar la zona, contando
    // desde DESPUÉS de la ruptura confirmada (e.i), no desde la propia vela
    // del OB. Antes se contaba desde obIdx+1, así que las velas del impulso
    // (antes de romper estructura) podían solaparse con la zona y marcarla
    // como "ya mitigada" casi de inmediato — por eso se veían tan cortas.
    for (let j = e.i + 1; j < k.c.length; j++) {
      if (k.l[j] <= ob.top && k.h[j] >= ob.bottom) { ob.mitigatedIdx = j; break; }
    }
    seen.set(obIdx, ob);
  }
  return [...seen.values()].sort((a, b) => a.i - b.i);
}

// ── Fair Value Gaps: hueco de 3 velas (imbalance) sin rellenar ──────────────
function smcFVGs(k) {
  const n = k.c.length;
  const start = Math.max(1, n - 400); // ~4 días a 15m alcanza, no hace falta escanear los 10 días completos
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

// ── Cálculo principal: se llama una vez por ciclo desde btcComputeFactors ──
function btcComputeSMC() {
  const k = btcChartData();
  if (!k || k.c.length < 30) { BTC.smc = null; return; }
  const { events, trend } = smcStructure(k);
  const obs  = smcOrderBlocks(k, events);
  const fvgs = smcFVGs(k);
  BTC.smc = { events, trend, obs, fvgs };
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

// ── Dibuja las zonas (OB/FVG) — SE LLAMA ANTES de pintar las velas, para que
// queden detrás ── y las rupturas BOS/CHoCH — se llama DESPUÉS de las velas,
// para que las etiquetas queden encima. Ambas reciben (ctx, x, y, s0, s1). ──
function smcDrawZones(ctx, x, y, s0, s1) {
  if (!_btcSmcOn || !BTC.smc) return;
  // FVG primero (más tenues, quedan debajo de los order blocks)
  for (const g of (BTC.smc.fvgs || [])) {
    const endI = g.filledIdx ?? (s1 - 1);
    if (endI < s0 || g.i - 1 >= s1) continue;
    const xa = x(Math.max(s0, g.i - 1)), xb = x(Math.min(s1 - 1, endI));
    const ya = y(g.top), yb = y(g.bottom);
    ctx.fillStyle = g.dir === 'bull' ? 'rgba(47,224,138,0.09)' : 'rgba(255,102,102,0.09)';
    ctx.fillRect(xa, Math.min(ya, yb), Math.max(2, xb - xa), Math.max(1, Math.abs(yb - ya)));
  }
  // Order blocks (bien marcados: relleno fuerte + brillo + alto mínimo para
  // que una vela de cuerpo chico no se vuelva una rayita invisible)
  const OB_MIN_H = 10; // px, alto mínimo de la caja
  for (const o of (BTC.smc.obs || [])) {
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
    const active = o.mitigatedIdx == null; // sin mitigar: sigue "viva", se dibuja más fuerte
    ctx.save();
    ctx.fillStyle = o.dir === 'bull'
      ? `rgba(47,224,138,${active ? 0.28 : 0.14})`
      : `rgba(255,102,102,${active ? 0.28 : 0.14})`;
    ctx.fillRect(xa, top, w, h);
    ctx.strokeStyle = col; ctx.globalAlpha = active ? 0.9 : 0.4; ctx.lineWidth = active ? 1.6 : 1;
    ctx.setLineDash(active ? [] : [3, 2]); // sólida = vigente · punteada = ya mitigada
    if (active) { ctx.shadowColor = col; ctx.shadowBlur = 4; }
    ctx.strokeRect(xa, top, w, h);
    ctx.restore();
    _smcChip(ctx, active ? 'OB' : 'OB ✓', xa + 15, top + h / 2 - 7, col);
  }
}

// Chip de texto con fondo sólido: el borde indica dirección (verde/rojo, igual
// que el resto del gráfico) pero la LETRA siempre en el mismo color brillante
// y neutro (blanco-azulado) para que se lea clara sobre cualquier vela/zona,
// en vez de perderse mezclada con el verde/rojo de las velas y las zonas OB.
const SMC_TEXT_COL = '#eef4ff';
function _smcChip(ctx, txt, cx, topY, borderCol) {
  ctx.font = '800 9.5px Inter,system-ui'; ctx.textAlign = 'center';
  const tw = ctx.measureText(txt).width;
  const w = tw + 10, h = 14;
  const x0 = cx - w / 2;
  ctx.fillStyle = 'rgba(6,9,14,0.95)';
  ctx.fillRect(x0, topY, w, h);
  ctx.strokeStyle = borderCol; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.1;
  ctx.strokeRect(x0, topY, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = SMC_TEXT_COL;
  ctx.fillText(txt, cx, topY + h - 4);
}

function smcDrawStructure(ctx, x, y, s0, s1) {
  if (!_btcSmcOn || !BTC.smc?.events?.length) return;
  for (const e of BTC.smc.events) {
    if (e.i < s0 || e.i >= s1) continue;
    const lineCol = e.dir === 'up' ? '#2fe08a' : '#ff6666';
    const x0 = x(Math.max(s0, e.fromI)), x1 = x(e.i);
    const ly = y(e.price);
    ctx.save();
    ctx.strokeStyle = lineCol; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x0, ly); ctx.lineTo(x1, ly); ctx.stroke();
    ctx.restore();
    const txt = `${e.type} ${e.dir === 'up' ? '▲' : '▼'}`;
    const chipY = e.dir === 'up' ? ly - 22 : ly + 8;
    _smcChip(ctx, txt, x1, chipY, lineCol);
  }
}
