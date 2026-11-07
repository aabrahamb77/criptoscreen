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
 *
 * v3 (nov 2026):
 *  · Contexto 4h SIEMPRE (tendencia mayor y su premium/discount), aparte del
 *    toggle 15m/1h del gráfico: la dirección se toma de arriba hacia abajo.
 *  · Liquidez con nombre: PDH/PDL (día anterior), PWH/PWL (semana anterior),
 *    máximo/mínimo de Asia y de Londres. Son los stops que el mercado va a buscar.
 *  · Order blocks con calidad: ★ si el impulso dejó un FVG (desplazamiento real),
 *    ★★ si además la vela del OB barrió liquidez.
 *  · Breaker blocks: un OB atravesado por un cierre cambia de bando (soporte roto
 *    = resistencia) hasta que el precio cierre de nuevo al otro lado.
 *  · Setup SMC (modelo de entrada): barrido de liquidez → CHoCH/BOS interno a
 *    favor → retroceso al OB del impulso. Da zona de entrada, stop tras el
 *    barrido y objetivos en la siguiente liquidez, con nota A+/A/B/C y aviso.
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
    // Calidad: ¿el impulso dejó un FVG a su favor? (desplazamiento) y ¿la vela
    // del OB barrió el extremo de las 20 velas previas? (cazó stops antes de girar)
    const atr = _patAtr(k) || 0;
    for (let j = obIdx + 1; j <= Math.min(k.c.length - 2, e.i + 1); j++) {
      const gap = bullish ? k.l[j + 1] - k.h[j - 1] : k.l[j - 1] - k.h[j + 1];
      if (gap >= SMC_FVG_MIN * atr) { ob.disp = true; break; }
    }
    const prev = [];
    for (let j = Math.max(0, obIdx - 20); j < obIdx; j++) prev.push(bullish ? k.l[j] : k.h[j]);
    if (prev.length >= 5) {
      const ext = bullish ? Math.min(...prev) : Math.max(...prev);
      const wick = bullish ? Math.min(k.l[obIdx], k.l[Math.min(k.c.length - 1, obIdx + 1)]) : Math.max(k.h[obIdx], k.h[Math.min(k.c.length - 1, obIdx + 1)]);
      ob.swept = bullish ? wick < ext : wick > ext;
    }
    ob.stars = (ob.disp ? 1 : 0) + (ob.disp && ob.swept ? 1 : 0);
    // Mitigación: primer retorno del precio a la zona tras la ruptura.
    // Violación: tras mitigar, un CIERRE atraviesa la zona completa — el OB
    // falló como OB… pero pasa a ser BREAKER: la zona cambia de bando (el
    // soporte roto hace de resistencia) hasta que un cierre la cruce de vuelta.
    for (let j = e.i + 1; j < k.c.length; j++) {
      if (ob.mitigatedIdx == null) {
        if (k.l[j] <= ob.top && k.h[j] >= ob.bottom) ob.mitigatedIdx = j;
      } else if (ob.violatedIdx == null) {
        if (ob.dir === 'bull' ? k.c[j] < ob.bottom : k.c[j] > ob.top) ob.violatedIdx = j;
      } else if (ob.dir === 'bull' ? k.c[j] > ob.top : k.c[j] < ob.bottom) { ob.breakerEndIdx = j; break; }
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
      if (o.breakerEndIdx != null) o.breakerEndIdx = mE(o.breakerEndIdx);
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
    htf: BTC.htf?.trend ? BTC.htf : null,
    keyLevels: smcKeyLevels(k15),
    setups: BTC.smc?.setups || null, // los recalcula btcSmcSetups() en su turno
    // compat: consumidores viejos leen .events/.trend → apuntan a la estructura mayor
    events: major.events.slice(-SMC_MAX_MAJOR), trend: major.trend,
  };
}

// ── Contexto 4h + velas diaria/semanal (para PDH/PDL y PWH/PWL) ─────────────
// Tres llamadas pequeñas a Bybit cada 15 min, directo desde el navegador.
function _smcKlines(list) {
  const l = [...(list || [])].reverse(); // Bybit devuelve la más reciente primero
  return {
    t: l.map(x => +x[0]), o: l.map(x => +x[1]), h: l.map(x => +x[2]),
    l: l.map(x => +x[3]), c: l.map(x => +x[4]), v: l.map(x => +x[5]),
  };
}

async function btcFetchHTF() {
  BTC.htf = { ...(BTC.htf || {}), ts: Date.now() };
  try {
    const [r4, rd, rw] = await Promise.all([
      bybitGet('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=240&limit=200'),
      bybitGet('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=D&limit=3'),
      bybitGet('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=W&limit=3'),
    ]);
    const k4 = _smcKlines(r4.result?.list);
    const d = _smcKlines(rd.result?.list), w = _smcKlines(rw.result?.list);
    if (k4.c.length < 40) return;
    const atr4 = _patAtr(k4) || 0;
    const st = smcStructure(k4, 3, atr4 * SMC_BREAK_BUF);
    const last = st.events[st.events.length - 1];
    BTC.htf = {
      ts: Date.now(), tf: '4h', trend: st.trend,
      last: last ? { type: last.type, dir: last.dir, price: last.price, t: k4.t[last.i], barsAgo: k4.c.length - 1 - last.i } : null,
      eq: smcEquilibrium(k4, st.pivots),
      // [anterior, actual] — la anterior es la cerrada (PDH/PDL, PWH/PWL)
      day:  d.c.length >= 2 ? { t: d.t[d.t.length - 2], h: d.h[d.h.length - 2], l: d.l[d.l.length - 2] } : null,
      week: w.c.length >= 2 ? { t: w.t[w.t.length - 2], h: w.h[w.h.length - 2], l: w.l[w.l.length - 2] } : null,
    };
  } catch (_) { /* sin contexto 4h este ciclo: el resto sigue igual */ }
}

// ── Liquidez con nombre ─────────────────────────────────────────────────────
// Máximos/mínimos que todo el mundo mira = donde se acumulan los stops.
// `fromI` = primera vela en la que el nivel ya existía (a partir de ahí cuenta
// si se barrió). `swept` = el precio ya lo atravesó (esa liquidez ya se cobró).
function smcKeyLevels(k) {
  if (!k?.c?.length) return [];
  const n = k.c.length;
  const out = [];
  const idxAt = ts => { for (let i = 0; i < n; i++) if (k.t[i] >= ts) return i; return n; };
  const push = (key, price, above, fromTs) => {
    if (!Number.isFinite(price)) return;
    const fromI = idxAt(fromTs);
    let sweptI = null;
    for (let i = fromI; i < n; i++) {
      if (above ? k.h[i] > price : k.l[i] < price) { sweptI = i; break; }
    }
    out.push({ key, price, above, fromI, sweptI, swept: sweptI != null });
  };
  const H = BTC.htf || {};
  if (H.day)  { push('PDH', H.day.h, true, H.day.t + 86_400_000);  push('PDL', H.day.l, false, H.day.t + 86_400_000); }
  if (H.week) { push('PWH', H.week.h, true, H.week.t + 7 * 86_400_000); push('PWL', H.week.l, false, H.week.t + 7 * 86_400_000); }

  // Sesiones: el último rango COMPLETO de Asia (00:00–08:00 UTC) y de Londres (08:00–13:30)
  const now = Date.now();
  const day0 = Math.floor(now / 86_400_000) * 86_400_000;
  const sess = (key, startMin, endMin) => {
    let s = day0 + startMin * 60_000, e = day0 + endMin * 60_000;
    if (now < e) { s -= 86_400_000; e -= 86_400_000; } // aún en curso: la de ayer
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < n; i++) {
      if (k.t[i] < s || k.t[i] >= e) continue;
      hi = Math.max(hi, k.h[i]); lo = Math.min(lo, k.l[i]);
    }
    if (hi > lo) { push(key + ' H', hi, true, e); push(key + ' L', lo, false, e); }
  };
  sess('Asia', 0, 480);
  sess('Londres', 480, 810);

  // El máximo de ayer suele ser también el de Asia o Londres: mismo nivel, una
  // sola bolsa de stops. Se fusionan los que están a ≤0,05 % ("PDH · Asia H").
  out.sort((a, b) => a.fromI - b.fromI);
  const merged = [];
  for (const L of out) {
    const m = merged.find(x => x.above === L.above && Math.abs(x.price - L.price) / L.price <= 0.0005);
    if (!m) { merged.push({ ...L }); continue; }
    m.key += ' · ' + L.key;
    if (L.swept && (!m.swept || L.sweptI < m.sweptI)) { m.swept = true; m.sweptI = L.sweptI; }
  }
  return merged;
}

// ═══ Setup SMC: barrido → CHoCH → retroceso al OB ════════════════════════════
// Se busca en "espacio LARGO". Para cortos se invierte la serie (precio → −precio,
// máximos ↔ mínimos), se corre el MISMO detector y se des-invierten los precios:
// una sola lógica, sin duplicar código espejo.
const SMC_SETUP_LOOKBACK = 64;  // velas 15m hacia atrás para buscar barridos (16h)
const SMC_SETUP_CHOCH_MAX = 24; // el CHoCH debe llegar ≤6h después del barrido
const SMC_SETUP_EXPIRE = 32;    // sin retroceso a la zona en 8h → caduca
const SMC_SETUP_KEY = 'scalp_btc_smcsetups';

function _smcNeg(k) {
  return { t: k.t, o: k.o.map(v => -v), c: k.c.map(v => -v), h: k.l.map(v => -v), l: k.h.map(v => -v), v: k.v };
}
function _smcSlice(k, n) {
  return { t: k.t.slice(0, n), o: k.o.slice(0, n), h: k.h.slice(0, n), l: k.l.slice(0, n), c: k.c.slice(0, n), v: k.v.slice(0, n) };
}

// k: velas (en espacio largo). ssl: liquidez de abajo [{price, fromI, kind, key}].
// targets: precios de liquidez de arriba (pools, PDH, clusters de liq., muros).
function _smcLongSetups(k, ssl, targets, atr, htfUp) {
  const n = k.c.length, nC = n - 1; // la última vela está en formación
  if (nC < 60 || !atr) return [];
  const kc = _smcSlice(k, nC);
  const intl = smcStructure(kc, SMC_WIN_INT, atr * SMC_BREAK_BUF);
  const ups = intl.events.filter(e => e.dir === 'up');

  // 1) Barridos: mecha bajo un nivel de liquidez INTACTO y cierre de vuelta encima
  const sweeps = [];
  for (let j = nC - 1; j >= Math.max(1, nC - SMC_SETUP_LOOKBACK); j--) {
    let best = null;
    for (const L of ssl) {
      if (L.fromI >= j - 1) continue;
      if (!(k.l[j] < L.price - 0.05 * atr)) continue;
      const back = k.c[j] > L.price || (j + 1 < nC && k.c[j + 1] > L.price);
      if (!back) continue;
      // el nivel tenía que seguir intacto hasta esta vela
      let intact = true;
      for (let i = Math.max(0, L.fromI); i < j; i++) if (k.l[i] < L.price - 0.05 * atr) { intact = false; break; }
      if (!intact) continue;
      const pri = L.kind === 'key' ? 3 : L.kind === 'eq' ? 2 : 1;
      if (!best || pri > best.pri || (pri === best.pri && L.price < best.L.price)) best = { L, pri };
    }
    if (best) sweeps.push({ j, ...best });
    if (sweeps.length >= 3) break;
  }

  const out = [];
  for (const sw of sweeps) {
    const j = sw.j;
    let sweepLow = k.l[j];
    if (j + 1 < nC) sweepLow = Math.min(sweepLow, k.l[j + 1]);
    const setup = { sweepI: j, sweepExt: sweepLow, level: sw.L, state: 'barrido', pts: 0 };
    // 2) CHoCH/BOS interno alcista después del barrido, sin perder el mínimo barrido
    const e = ups.find(ev => ev.i > j && ev.i - j <= SMC_SETUP_CHOCH_MAX);
    let lostLow = false;
    const until = e ? e.i : nC;
    for (let i = j + 2; i < until; i++) if (k.l[i] < sweepLow) { lostLow = true; break; }
    if (lostLow) continue; // el barrido no aguantó: no hay setup
    if (!e) {
      if (nC - j > SMC_SETUP_CHOCH_MAX) continue; // ya no llegará
      out.push(setup);
      continue;
    }
    setup.chochI = e.i; setup.chochType = e.type; setup.chochPrice = e.price;
    let legHigh = -Infinity;
    for (let i = j; i <= e.i; i++) legHigh = Math.max(legHigh, k.h[i]);

    // 3) POI: última vela bajista antes del primer impulso fuerte desde el mínimo
    let m0 = j;
    for (let i = j; i <= e.i; i++) if (k.l[i] < k.l[m0]) m0 = i;
    let d = -1;
    for (let i = m0; i <= e.i; i++) {
      const fvg = i >= 1 && i + 1 < n && k.l[i + 1] - k.h[i - 1] >= SMC_FVG_MIN * atr;
      if (k.c[i] - k.o[i] >= 0.6 * atr || fvg) { d = i; break; }
    }
    if (d < 0) d = e.i;
    let ob = -1;
    for (let i = d - 1; i >= Math.max(0, Math.min(j, m0) - 3); i--) if (k.c[i] < k.o[i]) { ob = i; break; }
    if (ob < 0) ob = m0;
    let zTop = k.h[ob], zBot = k.l[ob];
    if (zTop - zBot > 1.2 * atr) zBot = (zTop + zBot) / 2; // OB enorme: solo la mitad superior
    // FVG del desplazamiento (refina la zona y suma calidad)
    let fvg = null;
    for (let i = Math.max(1, m0); i <= Math.min(n - 2, e.i + 1); i++) {
      const g = k.l[i + 1] - k.h[i - 1];
      if (g >= SMC_FVG_MIN * atr && (!fvg || g > fvg.top - fvg.bottom)) fvg = { i, top: k.l[i + 1], bottom: k.h[i - 1] };
    }
    const entry = (zTop + zBot) / 2;
    const stop = sweepLow - 0.15 * atr;
    Object.assign(setup, { state: 'armado', obI: ob, zTop, zBot, entry, stop, fvg });

    // 4) Qué pasó después del CHoCH (la vela en formación cuenta para tocar
    //    zona/stop/objetivo). Mientras el precio NO vuelva a la zona, el tramo
    //    se sigue extendiendo: cada máximo nuevo es la liquidez que queda arriba
    //    y el objetivo. Al tocar la zona, T1 se congela en el máximo del tramo.
    for (let i = e.i + 1; i < n; i++) {
      if (setup.state === 'armado') {
        if (i < nC && k.c[i] < sweepLow) { setup.state = 'invalidado'; setup.endI = i; break; }
        if (k.l[i] <= zTop) {
          setup.state = 'en zona'; setup.touchI = i;
          if (k.l[i] <= stop) { setup.state = 'stop'; setup.endI = i; break; }
          continue;
        }
        legHigh = Math.max(legHigh, k.h[i]);
        if (i - e.i > SMC_SETUP_EXPIRE && i < nC) { setup.state = 'caducado'; setup.endI = i; break; }
      } else if (setup.state === 'en zona') {
        if (k.l[i] <= stop) { setup.state = 'stop'; setup.endI = i; break; }
        if (k.h[i] >= legHigh) { setup.state = 'objetivo'; setup.endI = i; break; }
      }
    }

    const t1 = legHigh;
    const t2 = targets.filter(p => p > t1 + Math.abs(t1) * 0.001).sort((a, b) => a - b)[0] ?? null;
    const pos = (entry - sweepLow) / Math.max(1e-9, legHigh - sweepLow); // 0 = mínimo, 1 = máximo del tramo
    Object.assign(setup, { t1, t2, pos, rr: (t1 - entry) / Math.max(1e-9, entry - stop) });
    // Nota: 4 puntos — contexto 4h, discount, liquidez con nombre/iguales, desplazamiento
    setup.checks = { htf: htfUp === true, discount: pos <= 0.5, liq: sw.pri >= 2, disp: !!fvg };
    setup.pts = Object.values(setup.checks).filter(Boolean).length;
    out.push(setup);
  }
  return out;
}

function btcSmcSetups() {
  const k = btcChartData();
  if (!BTC.smc || !k || k.c.length < 120) return;
  const n = k.c.length, nC = n - 1;
  const atr = _patAtr(k) || 0;
  if (!atr) return;
  const htfTrend = BTC.htf?.trend;

  // Candidatos de liquidez: pivotes internos (±3) de las últimas ~250 velas,
  // marcados "eq" si hay otro a <0,2×ATR (equal highs/lows), + niveles con nombre
  const piv = _patPivots(_smcSlice(k, nC), SMC_WIN_INT).filter(p => p.i >= nC - 250);
  const mk = (type) => {
    const ps = piv.filter(p => p.type === type);
    return ps.map(p => ({
      price: p.price, fromI: p.i + SMC_WIN_INT, kind: ps.some(q => q !== p && Math.abs(q.price - p.price) < 0.2 * atr) ? 'eq' : 'swing',
      key: null,
    }));
  };
  const kl = BTC.smc.keyLevels || [];
  const named = above => kl.filter(L => L.above === above).map(L => ({ price: L.price, fromI: L.fromI, kind: 'key', key: L.key }));
  const sslL = [...mk('L'), ...named(false)];
  const bslL = [...mk('H'), ...named(true)];

  // Objetivos: liquidez del lado contrario (pools, niveles con nombre sin barrer,
  // clusters de liquidaciones del modelo y muros del order book)
  const L = BTC.liq || {};
  const up = [...(L.poolsAbove || []).map(p => p.level), ...kl.filter(x => x.above && !x.swept).map(x => x.price),
    ...(BTC.liqm?.above || []).map(c => c.level), ...(BTC.ob?.askWalls || []).map(w => w.price)];
  const dn = [...(L.poolsBelow || []).map(p => p.level), ...kl.filter(x => !x.above && !x.swept).map(x => x.price),
    ...(BTC.liqm?.below || []).map(c => c.level), ...(BTC.ob?.bidWalls || []).map(w => w.price)];

  const longs = _smcLongSetups(k, sslL, up, atr, htfTrend ? htfTrend === 'up' : null)
    .map(s => ({ ...s, dir: 'long' }));
  const neg = v => v == null ? v : -v;
  const shorts = _smcLongSetups(_smcNeg(k), bslL.map(x => ({ ...x, price: -x.price })), dn.map(p => -p), atr, htfTrend ? htfTrend === 'down' : null)
    .map(s => ({
      ...s, dir: 'short', sweepExt: -s.sweepExt, level: { ...s.level, price: -s.level.price },
      zTop: neg(s.zBot), zBot: neg(s.zTop), entry: neg(s.entry), stop: neg(s.stop), t1: neg(s.t1), t2: neg(s.t2),
      chochPrice: neg(s.chochPrice), fvg: s.fvg ? { i: s.fvg.i, top: -s.fvg.bottom, bottom: -s.fvg.top } : null,
    }));

  const ACTIVE = new Set(['barrido', 'armado', 'en zona']);
  const all = [...longs, ...shorts].map(s => {
    s.id = `${s.dir}|${k.t[s.sweepI]}`;
    s.grade = s.pts >= 4 ? 'A+' : s.pts === 3 ? 'A' : s.pts === 2 ? 'B' : 'C';
    s.ts = k.t[s.chochI ?? s.sweepI];
    return s;
  });
  // El activo de cada lado = el más reciente que siga vivo
  const pick = dir => all.filter(s => s.dir === dir && ACTIVE.has(s.state)).sort((a, b) => b.sweepI - a.sweepI)[0] || null;
  const active = [pick('long'), pick('short')].filter(Boolean);
  BTC.smc.setups = { active, all, nBars: n };
  _smcSetupLog(all);
  _smcSetupAlerts(active);
}

// ── Historial (solo los que llegaron a "armado") ─────────────────────────────
function _smcSetupLog(all) {
  let hist;
  try { hist = JSON.parse(localStorage.getItem(SMC_SETUP_KEY) || '[]'); } catch (_) { hist = []; }
  let dirty = false;
  for (const s of all) {
    if (s.state === 'barrido') continue;
    const rec = {
      id: s.id, dir: s.dir, grade: s.grade, pts: s.pts, ts: s.ts, key: s.level?.key || (s.level?.kind === 'eq' ? 'iguales' : 'swing'),
      entry: s.entry, stop: s.stop, t1: s.t1, rr: s.rr, state: s.state,
    };
    const i = hist.findIndex(h => h.id === s.id);
    if (i < 0) { hist.push(rec); dirty = true; }
    else if (hist[i].state !== s.state) { hist[i] = { ...hist[i], ...rec }; dirty = true; }
  }
  if (dirty) {
    hist.sort((a, b) => a.ts - b.ts);
    if (hist.length > 30) hist = hist.slice(-30);
    safeSetItem(SMC_SETUP_KEY, JSON.stringify(hist));
  }
}
function btcSmcSetupHistory() {
  try { return JSON.parse(localStorage.getItem(SMC_SETUP_KEY) || '[]'); } catch (_) { return []; }
}

// ── Avisos: "armado" solo aviso visual; "en zona" con sonido (categoría btcSmc) ─
let _smcAlerted = (() => { try { return new Set(JSON.parse(localStorage.getItem('scalp_btc_smcalert') || '[]')); } catch (_) { return new Set(); } })();
function _smcSetupAlerts(active) {
  const fp = fmtPrice;
  let dirty = false;
  for (const s of active) {
    if (s.pts < 2 || s.state === 'barrido') continue; // C: solo en el panel, sin aviso
    const tag = `${s.id}|${s.state}`;
    if (_smcAlerted.has(tag)) continue;
    _smcAlerted.add(tag); dirty = true;
    const lado = s.dir === 'long' ? 'LARGO' : 'CORTO';
    const lvl = s.level?.key || (s.level?.kind === 'eq' ? 'iguales' : 'swing');
    const txt = s.state === 'armado'
      ? `🧠 Setup SMC ${lado} ${s.grade} armado: barrió ${lvl} ${fp(s.level.price)} + ${s.chochType}. Esperando retroceso a ${fp(s.zBot)}–${fp(s.zTop)}`
      : `🧠 BTC en la zona del setup SMC ${lado} ${s.grade}: ${fp(s.zBot)}–${fp(s.zTop)} · stop ${fp(s.stop)} · T1 ${fp(s.t1)} (R:R ${s.rr.toFixed(1)})`;
    if (!canAlert('btcSmc')) continue;
    showToast(txt, s.dir);
    notifyDesktop(`🧠 Setup SMC ${lado} ${s.grade} — ${s.state}`, txt.replace(/^🧠 /, ''));
    if (s.state === 'en zona') playAlertSound('btcSmc', s.dir);
  }
  if (dirty) {
    const arr = [..._smcAlerted].slice(-60);
    _smcAlerted = new Set(arr);
    try { localStorage.setItem('scalp_btc_smcalert', JSON.stringify(arr)); } catch (_) { /* sin espacio */ }
  }
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
    const stars = o.stars ? ' ' + '★'.repeat(o.stars) : '';
    _smcChip(ctx, (active ? 'OB' : 'OB ✓') + stars, xa + 15 + (stars ? 6 : 0), top + h / 2 - 7, col);
  }

  // Breaker blocks: OB atravesado que ahora trabaja del lado contrario.
  // Solo los vigentes (sin cierre de vuelta) y como mucho los 3 más recientes.
  const brk = (BTC.smc.obs || []).filter(o => o.violatedIdx != null && o.breakerEndIdx == null).slice(-3);
  for (const o of brk) {
    if (o.violatedIdx >= s1) continue;
    const xa = x(Math.max(s0, o.violatedIdx)), xb = x(s1 - 1);
    if (xb <= xa) continue;
    let ya = y(o.top), yb = y(o.bottom);
    if (Math.abs(yb - ya) < OB_MIN_H) { const cy = (ya + yb) / 2; ya = cy - OB_MIN_H / 2; yb = cy + OB_MIN_H / 2; }
    const top = Math.min(ya, yb), h = Math.max(OB_MIN_H, Math.abs(yb - ya));
    const bearish = o.dir === 'bull'; // un OB alcista roto pasa a frenar subidas
    const col = bearish ? '#ff6666' : '#2fe08a';
    ctx.save();
    ctx.fillStyle = bearish ? 'rgba(255,102,102,0.10)' : 'rgba(47,224,138,0.10)';
    ctx.fillRect(xa, top, xb - xa, h);
    ctx.strokeStyle = col; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.2; ctx.setLineDash([6, 3]);
    ctx.strokeRect(xa, top, xb - xa, h);
    ctx.restore();
    _smcChip(ctx, `BRK ${bearish ? '▼' : '▲'}`, xa + 22, top + h / 2 - 7, col);
  }

  smcDrawSetups(ctx, x, y, s0, s1);
}

// Setup activo: zona de entrada (caja), línea del nivel barrido y etiqueta con
// la nota. Entrada/stop/objetivos van como niveles en la columna derecha
// (btcSmcSetupLevels) para que se lean con su precio exacto.
function smcDrawSetups(ctx, x, y, s0, s1) {
  const act = BTC.smc?.setups?.active || [];
  for (const s of act) {
    const col = s.dir === 'long' ? '#2fe08a' : '#ff6666';
    // nivel de liquidez barrido: línea desde que existía hasta el barrido
    if (s.level && s.sweepI >= s0) {
      const xa = x(Math.max(s0, Math.min(s.sweepI - 1, s.level.fromI ?? s.sweepI - 12))), xb = x(Math.min(s1 - 1, s.sweepI + 2));
      ctx.save();
      ctx.strokeStyle = '#c9a7ff'; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.3; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(xa, y(s.level.price)); ctx.lineTo(xb, y(s.level.price)); ctx.stroke();
      ctx.restore();
      const lbl = s.level.key || (s.level.kind === 'eq' ? 'iguales' : 'swing');
      _smcChip(ctx, `💧 barrido ${lbl}`, x(Math.max(s0, s.sweepI)), s.dir === 'long' ? y(s.sweepExt) + 6 : y(s.sweepExt) - 20, '#c9a7ff');
    }
    if (s.state === 'barrido' || s.zTop == null) continue;
    const xa = x(Math.max(s0, s.obI)), xb = x(s1 - 1);
    if (xb <= xa) continue;
    const ya = y(s.zTop), yb = y(s.zBot);
    ctx.save();
    ctx.fillStyle = s.dir === 'long' ? 'rgba(47,224,138,0.16)' : 'rgba(255,102,102,0.16)';
    ctx.fillRect(xa, Math.min(ya, yb), xb - xa, Math.max(3, Math.abs(yb - ya)));
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash([5, 3]);
    ctx.strokeRect(xa, Math.min(ya, yb), xb - xa, Math.max(3, Math.abs(yb - ya)));
    ctx.restore();
    const txt = `SETUP ${s.dir === 'long' ? 'L' : 'S'} ${s.grade} · ${s.state === 'en zona' ? 'EN ZONA' : 'esperando retroceso'} · R:R ${s.rr.toFixed(1)}`;
    _smcChip(ctx, txt, Math.min(xb - 90, xa + 90), Math.min(ya, yb) - 17, col);
  }
}

// Niveles del setup para la columna de etiquetas del gráfico
function btcSmcSetupLevels() {
  const out = [];
  for (const s of (BTC.smc?.setups?.active || [])) {
    if (s.zTop == null || s.state === 'barrido') continue;
    const L = s.dir === 'long' ? 'L' : 'S';
    out.push({ v: s.entry, col: '#e8edf8', dash: [1, 2], label: `▶ entrada ${L} (50% OB)` });
    out.push({ v: s.stop, col: '#ff4d6d', dash: [], label: `⛔ stop ${L}` });
    out.push({ v: s.t1, col: '#2fe08a', dash: [4, 2], label: `🎯 T1 ${L}` });
    if (s.t2 != null) out.push({ v: s.t2, col: '#2fe08a', dash: [8, 3], label: `🎯 T2 ${L}` });
  }
  return out;
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
