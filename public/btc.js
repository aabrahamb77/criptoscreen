/* public/btc.js
 * ₿ BTC — Sistema de DIRECCIONALIDAD por confluencia.
 *
 * Cada factor vota entre −1 y +1 y tiene un peso; la suma ponderada da un
 * sesgo −100..+100 → probabilidad direccional, SIEMPRE con el porqué en texto.
 *
 * Factores (datos gratuitos, casi todo pedido directo desde el navegador):
 *  1. Flujo de dinero (25): OI multi-ventana + precio + CVD + funding
 *  2. Long/Short ratio (15): cuentas long vs short (lectura contrarian del retail)
 *  3. Barridos de liquidez (15): mecha que caza stops (pivote o PDH/PDL/Asia/Londres) y recupera
 *  3b. Estructura SMC (12) con contexto 4h · 3c. Setup SMC activo (10) — smc.js
 *  4. Imanes (15): clusters del mapa de liquidaciones estimado (btcliq.js); si no, pools
 *  5. Muros de order book (10): 5 libros combinados, tramos ≥2,5× el típico (btcbook.js)
 *  6. Max pain de opciones (10): strike que minimiza el pago del vencimiento cercano
 *  7. Basis perp-spot (10): premium = sobrecalentado, descuento = miedo
 *  + Top traders, Coinbase Premium y Spot vs Perp (fuentes públicas)
 *
 * CoinGlass: la API key del .env responde "Upgrade plan" a TODO (nov 2026), así
 * que nada depende de ella; si algún día el plan cambia, los módulos CG vuelven solos.
 * Para cruzar con su heatmap: 📸 pegar una captura (Claude la lee en /api/vision/cg).
 *
 * Sesiones: Asia 00:00 · Londres 08:00 · Nueva York 13:30 (UTC). Al abrir cada
 * sesión se guarda un snapshot del sesgo para comparar contra lo que pasó.
 */

const BTC_SESSIONS = [
  { key: 'Asia',       utcH: 0,  utcM: 0  },
  { key: 'Londres',    utcH: 8,  utcM: 0  },
  { key: 'Nueva York', utcH: 13, utcM: 30 },
];

const BTC = {
  ob: null,      // { bidWalls, askWalls, bidUSD, askUSD, mid, ts }
  ls: null,      // { buyRatio, prevBuyRatio, ts }
  mp: null,      // { price, expiry, expiryTs, ts }
  spot: null,    // { price, basisPct, ts }
  liq: null,     // { pools, sweeps } — calculado de k15
  factors: [],
  bias: 0, prob: 50, dir: 'NEUTRAL',
  lastDir: null,
  cg: { ts: 0, top: null, mp: null, clusters: null, err: {} }, // CoinGlass (vía /api/cg)
  free: { ts: 0, topLS: null, prem: null, taker: null },       // respaldo gratuito (Binance/Coinbase/Bybit)
};

// ── Fetchers (cadencias propias, solo BTC = coste mínimo) ───────────────────

// Order book: ver btcbook.js (btcBookFetch) — 5 libros combinados directo
// desde el navegador. Deja BTC.ob con la misma forma de siempre.

async function btcFetchLS() {
  BTC.ls = { ...(BTC.ls || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=15min&limit=16');
    const list = r.result?.list || [];
    if (!list.length) return;
    // list[0] = más reciente
    const cur = parseFloat(list[0].buyRatio);
    const prev = list.length > 4 ? parseFloat(list[4].buyRatio) : cur; // hace 1h
    if (Number.isFinite(cur)) BTC.ls = { buyRatio: cur, prevBuyRatio: prev, ts: Date.now() };
  } catch (_) {}
}

async function btcFetchOptions() {
  BTC.mp = { ...(BTC.mp || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/tickers?category=option&baseCoin=BTC');
    const list = r.result?.list || [];
    const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const byExp = new Map();
    for (const t of list) {
      const parts = t.symbol.split('-'); // BTC-27JUN25-65000-C
      if (parts.length < 4) continue;
      const oi = parseFloat(t.openInterest || 0);
      if (!oi) continue;
      if (!byExp.has(parts[1])) byExp.set(parts[1], []);
      byExp.get(parts[1]).push({ strike: +parts[2], type: parts[3], oi });
    }
    const parseExp = e => {
      const day = parseInt(e); const mon = MON[e.replace(/[0-9]/g, '').toUpperCase()];
      const yr = 2000 + parseInt(e.slice(-2));
      return (mon == null || !day || !yr) ? NaN : Date.UTC(yr, mon, day, 8);
    };
    const exps = [...byExp.keys()].map(e => ({ e, ts: parseExp(e) }))
      .filter(x => Number.isFinite(x.ts) && x.ts > Date.now())
      .sort((a, b) => a.ts - b.ts);
    if (!exps.length) return;
    const chain = byExp.get(exps[0].e);
    const strikes = [...new Set(chain.map(c => c.strike))].sort((a, b) => a - b);
    let best = null;
    for (const K of strikes) {
      let pay = 0;
      for (const c of chain) {
        pay += c.type === 'C' ? c.oi * Math.max(0, K - c.strike) : c.oi * Math.max(0, c.strike - K);
      }
      if (!best || pay < best.pay) best = { pay, K };
    }
    BTC.mp = { price: best.K, expiry: exps[0].e, expiryTs: exps[0].ts, ts: Date.now() };
  } catch (_) {}
}

async function btcFetchSpot() {
  BTC.spot = { ...(BTC.spot || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/tickers?category=spot&symbol=BTCUSDT');
    const p = parseFloat(r.result?.list?.[0]?.lastPrice);
    const row = allRows.find(x => x.symbol === 'BTC');
    if (Number.isFinite(p) && row?.price) {
      BTC.spot = { price: p, basisPct: (row.price - p) / p * 100, ts: Date.now() };
    }
  } catch (_) {}
}

// ── CoinGlass (vía proxy /api/cg — requiere COINGLASS_API_KEY en .env) ──────
async function btcFetchCG() {
  BTC.cg.ts = Date.now();
  const get = async path => {
    try {
      const r = await fetch('/api/cg/' + path);
      if (r.status === 503) return { err: 'sin API key en .env' };
      if (!r.ok) return { err: 'HTTP ' + r.status };
      const j = await r.json();
      if (j.code !== '0' && j.code !== 0) return { err: j.msg || 'no incluido en tu plan' };
      return { data: j.data };
    } catch (_) { return { err: 'sin conexión' }; }
  };

  // 1) Top traders de Binance (posiciones, 4h) — disponible en TODOS los planes
  const top = await get('futures/top-long-short-position-ratio/history?exchange=Binance&symbol=BTCUSDT&interval=4h&limit=8');
  if (Array.isArray(top.data) && top.data.length) {
    const arr = top.data;
    const last = arr[arr.length - 1];
    const prev = arr.length > 2 ? arr[arr.length - 3] : last;
    BTC.cg.top = { longPct: +last.top_position_long_percent, prev: +prev.top_position_long_percent };
    BTC.cg.err.top = null;
  } else { BTC.cg.top = null; BTC.cg.err.top = top.err || 'sin datos'; }

  // 2) Max pain de Deribit (mercado dominante de opciones) — todos los planes
  const mp = await get('option/max-pain?symbol=BTC&exchange=Deribit');
  if (Array.isArray(mp.data) && mp.data.length) {
    const parse = d => { const s = String(d); return Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6), 8); };
    const rows = mp.data.map(x => ({ ...x, ts: parse(x.date) }))
      .filter(x => Number.isFinite(x.ts) && x.ts > Date.now() - 8 * 3600_000)
      .sort((a, b) => a.ts - b.ts);
    if (rows.length) {
      const r0 = rows[0];
      BTC.cg.mp = {
        price: +r0.max_pain_price, expiry: String(r0.date), expiryTs: r0.ts,
        pcr: r0.call_open_interest_notional ? r0.put_open_interest_notional / r0.call_open_interest_notional : null,
      };
      BTC.cg.err.mp = null;
    }
  } else { BTC.cg.mp = null; BTC.cg.err.mp = mp.err || 'sin datos'; }

  // 3) Heatmap de liquidaciones agregado (solo plan Professional+)
  const hm = await get('futures/liquidation/aggregated-heatmap/model2?symbol=BTC&range=24h');
  if (hm.data?.y_axis && hm.data?.liquidation_leverage_data) {
    const y = hm.data.y_axis;
    const cells = hm.data.liquidation_leverage_data;
    const maxX = cells.reduce((m, c) => Math.max(m, c[0]), 0);
    const byY = new Map();
    for (const [x, yi, usd] of cells) {
      if (x < maxX - 2) continue; // solo las columnas más recientes = liquidez AÚN pendiente
      byY.set(yi, (byY.get(yi) || 0) + usd);
    }
    const price = allRows.find(r => r.symbol === 'BTC')?.price;
    let above = null, below = null;
    for (const [yi, usd] of byY) {
      const lvl = y[yi];
      if (lvl == null || !price) continue;
      if (lvl > price && (!above || usd > above.usd)) above = { level: lvl, usd };
      if (lvl < price && (!below || usd > below.usd)) below = { level: lvl, usd };
    }
    BTC.cg.clusters = { above, below };
    BTC.cg.err.hm = null;
  } else { BTC.cg.clusters = null; BTC.cg.err.hm = hm.err || 'sin datos'; }

  // 4) Coinbase Premium — demanda institucional americana (todos los planes, ≥4h)
  const cbp = await get('coinbase-premium-index?interval=4h&limit=12');
  if (Array.isArray(cbp.data) && cbp.data.length) {
    const arr = cbp.data;
    const last = arr[arr.length - 1];
    const prev = arr.slice(-6, -1);
    BTC.cg.cbp = {
      rate: +last.premium_rate, premium: +last.premium,
      prevAvg: prev.length ? prev.reduce((a, x) => a + (+x.premium_rate || 0), 0) / prev.length : +last.premium_rate,
    };
    BTC.cg.err.cbp = null;
  } else { BTC.cg.cbp = null; BTC.cg.err.cbp = cbp.err || 'sin datos'; }

  // 5) Flujos de ETF de Bitcoin (dato diario) — todos los planes
  const etf = await get('etf/bitcoin/flow-history');
  if (Array.isArray(etf.data) && etf.data.length) {
    const arr = etf.data.slice(-5);
    const last = arr[arr.length - 1];
    BTC.cg.etf = {
      lastFlow: +last.flow_usd,
      sum3: arr.slice(-3).reduce((a, x) => a + (+x.flow_usd || 0), 0),
      ts: +last.timestamp,
    };
    BTC.cg.err.etf = null;
  } else { BTC.cg.etf = null; BTC.cg.err.etf = etf.err || 'sin datos'; }

  // 6) Agresión spot vs perp (taker buy/sell agregado Binance+OKX+Bybit, 4h)
  const [tbF, tbS] = await Promise.all([
    get('futures/aggregated-taker-buy-sell-volume/history?exchange_list=Binance,OKX,Bybit&symbol=BTC&interval=4h&limit=4'),
    get('spot/aggregated-taker-buy-sell-volume/history?exchange_list=Binance,OKX,Bybit&symbol=BTC&interval=4h&limit=4'),
  ]);
  const takerRatio = arr => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr.slice(-2); // últimas ~8h
    const b = r.reduce((a, x) => a + (+x.aggregated_buy_volume_usd || 0), 0);
    const s = r.reduce((a, x) => a + (+x.aggregated_sell_volume_usd || 0), 0);
    return b + s > 0 ? b / (b + s) : null;
  };
  const rFut = takerRatio(tbF.data), rSpot = takerRatio(tbS.data);
  if (rFut != null && rSpot != null) { BTC.cg.taker = { spot: rSpot, fut: rFut }; BTC.cg.err.taker = null; }
  else { BTC.cg.taker = null; BTC.cg.err.taker = tbF.err || tbS.err || 'sin datos'; }

  // 7) Historial de liquidaciones agregado multi-exchange (para el gráfico)
  const lh = await get('futures/liquidation/aggregated-history?exchange_list=Binance,OKX,Bybit&symbol=BTC&interval=4h&limit=120');
  if (Array.isArray(lh.data) && lh.data.length) {
    BTC.cg.liqHist = lh.data.map(x => ({
      t: +x.time,
      l: +x.aggregated_long_liquidation_usd || 0,
      s: +x.aggregated_short_liquidation_usd || 0,
    }));
    BTC.cg.err.liqHist = null;
  } else { BTC.cg.liqHist = null; BTC.cg.err.liqHist = lh.err || 'sin datos'; }

  BTC.cg.allFail = ['top', 'mp', 'hm', 'cbp', 'etf', 'taker', 'liqHist'].every(kk => BTC.cg.err[kk]);
  btcComputeFactors();
  if (activeTab === 'btc') renderBTC();
}

// ── Fuentes GRATUITAS de respaldo (cuando tu plan de CoinGlass no llega) ─────
// Mismos datos, directo de fuentes públicas sin API key: los factores usan
// CoinGlass si responde y si no caen aquí — nada se queda en peso 0.
async function btcFetchFree() {
  BTC.free = { ...(BTC.free || {}), ts: Date.now() };

  // 🐋 Top traders de Binance (endpoint público de Binance Futures, sin key)
  // Directo desde el navegador (Binance permite CORS). Antes iba por el server
  // y en Render fallaba siempre: Binance bloquea las IPs de EE. UU. (HTTP 451).
  try {
    const r = await fetch('https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1h&limit=8').then(x => x.json());
    if (Array.isArray(r) && r.length) {
      const last = r[r.length - 1];
      const prev = r.length > 2 ? r[r.length - 3] : last;
      const cur = parseFloat(last.longAccount) * 100;
      if (Number.isFinite(cur)) BTC.free.topLS = { longPct: cur, prev: parseFloat(prev.longAccount) * 100 };
    }
  } catch (_) {}

  // 🇺🇸 Premium Coinbase vs Binance calculado en vivo con precios spot públicos
  try {
    const [cb, bn] = await Promise.all([
      fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(x => x.json()),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(x => x.json()),
    ]);
    const r = { coinbase: parseFloat(cb?.data?.amount), binance: parseFloat(bn?.price) };
    if (Number.isFinite(r.coinbase) && Number.isFinite(r.binance) && r.binance > 0) {
      const prevRate = BTC.free.prem?.rate ?? null;
      BTC.free.prem = { rate: (r.coinbase - r.binance) / r.binance * 100, prevRate };
    }
  } catch (_) {}

  // 🔀 Agresión spot vs perp: últimos ~1000 trades de Bybit en cada mercado
  // (ventana corta, ~15-40 min — más reactivo que las velas 4h de CoinGlass)
  try {
    const [sp, ln] = await Promise.all([
      bybitGet('/v5/market/recent-trade?category=spot&symbol=BTCUSDT&limit=1000'),
      bybitGet('/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=1000'),
    ]);
    const ratio = res2 => {
      const list = res2?.result?.list || [];
      let b = 0, s = 0;
      for (const t of list) { const v = (+t.size) * (+t.price); if (t.side === 'Buy') b += v; else s += v; }
      return b + s > 0 ? b / (b + s) : null;
    };
    const rS = ratio(sp), rF = ratio(ln);
    if (rS != null && rF != null) BTC.free.taker = { spot: rS, fut: rF };
  } catch (_) {}

  btcComputeFactors();
  if (activeTab === 'btc') renderBTC();
}

// ── Liquidaciones de BTC capturadas EN VIVO (WS de Bybit), por vela de 15m ──
// Persisten en localStorage (~10 días): alimentan la banda del gráfico cuando
// el historial de CoinGlass no está disponible en tu plan.
let _btcLiqB = JSON.parse(localStorage.getItem('scalp_btc_liqb') || '{}');
let _btcLiqLastTs = 0;
function btcAccumLiqs() {
  let dirty = false;
  for (const e of liqEvents) {
    if (e.symbol !== 'BTC' || e.ts <= _btcLiqLastTs) continue;
    const b = Math.floor(e.ts / 900_000) * 900_000;
    if (!_btcLiqB[b]) _btcLiqB[b] = { l: 0, s: 0 };
    _btcLiqB[b][e.isLong ? 'l' : 's'] += e.usdVal;
    dirty = true;
  }
  for (const e of liqEvents) if (e.ts > _btcLiqLastTs) _btcLiqLastTs = e.ts;
  if (dirty) {
    const cut = Date.now() - 10 * 86_400_000;
    for (const kk of Object.keys(_btcLiqB)) if (+kk < cut) delete _btcLiqB[kk];
    safeSetItem('scalp_btc_liqb', JSON.stringify(_btcLiqB));
  }
}

// ── Liquidez: pools (equal highs/lows sin barrer) y barridos recientes ──────
function btcLiquidity(row) {
  const k = row.k15;
  if (!k || k.c.length < 30) return null;
  const n = k.c.length, last = k.c[n - 1];
  const atr = _patAtr(k);
  if (!atr) return null;
  const piv = _patPivots(k, 2);
  const highs = piv.filter(p => p.type === 'H');
  const lows  = piv.filter(p => p.type === 'L');

  const pools = [];
  const findPools = (exts, above) => {
    for (let i = 0; i < exts.length; i++) {
      for (let j = i + 1; j < exts.length; j++) {
        if (Math.abs(exts[i].price - exts[j].price) > 0.2 * atr) continue;
        const lvl = above ? Math.max(exts[i].price, exts[j].price) : Math.min(exts[i].price, exts[j].price);
        const swept = above
          ? k.h.slice(exts[j].i + 1).some(h => h > lvl + 0.05 * atr)
          : k.l.slice(exts[j].i + 1).some(l => l < lvl - 0.05 * atr);
        if (swept) continue;
        if (above ? lvl > last : lvl < last) pools.push({ above, level: lvl });
      }
    }
  };
  findPools(highs, true);
  findPools(lows, false);
  // dedupe niveles a <0.15×ATR y quedarse con los 2 más cercanos por lado
  const dedupe = arr => {
    arr.sort((a, b) => Math.abs(a.level - last) - Math.abs(b.level - last));
    const out = [];
    for (const p of arr) if (!out.some(o => Math.abs(o.level - p.level) < 0.15 * atr)) out.push(p);
    return out.slice(0, 2);
  };
  const poolsAbove = dedupe(pools.filter(p => p.above));
  const poolsBelow = dedupe(pools.filter(p => !p.above));

  // Barridos en las últimas 8 velas: mecha caza el pivote y el cierre recupera
  let sweptLow = null, sweptHigh = null;
  for (let i = Math.max(1, n - 8); i < n; i++) {
    for (const pl of lows) {
      if (pl.i < i - 2 && k.l[i] < pl.price - 0.05 * atr && k.c[i] > pl.price) sweptLow = { level: pl.price, barsAgo: n - 1 - i };
    }
    for (const ph of highs) {
      if (ph.i < i - 2 && k.h[i] > ph.price + 0.05 * atr && k.c[i] < ph.price) sweptHigh = { level: ph.price, barsAgo: n - 1 - i };
    }
  }

  // Barridos de liquidez CON NOMBRE (PDH/PDL, Asia, Londres, semana): pesan más
  // que un pivote cualquiera porque ahí está la mayor bolsa de stops. Cuenta si
  // la vela que lo atravesó cerró de vuelta dentro, o si el precio ya volvió.
  const kc = btcChartData();
  const kl = BTC.smc?.keyLevels || [];
  if (kc && kl.length) {
    const nn = kc.c.length;
    for (const Lv of kl) {
      if (Lv.sweptI == null || nn - 1 - Lv.sweptI > 7) continue;
      const i = Lv.sweptI;
      const back = Lv.above ? (kc.c[i] < Lv.price || kc.c[nn - 1] < Lv.price) : (kc.c[i] > Lv.price || kc.c[nn - 1] > Lv.price);
      if (!back) continue;
      const ev = { level: Lv.price, barsAgo: nn - 1 - i, key: Lv.key };
      if (Lv.above) { if (!sweptHigh || ev.barsAgo <= sweptHigh.barsAgo + 2) sweptHigh = ev; }
      else          { if (!sweptLow  || ev.barsAgo <= sweptLow.barsAgo + 2)  sweptLow  = ev; }
    }
  }
  return { poolsAbove, poolsBelow, sweptLow, sweptHigh, atr };
}

// ── Cálculo del sesgo por confluencia ───────────────────────────────────────
function btcComputeFactors() {
  const row = allRows.find(r => r.symbol === 'BTC');
  if (!row) return;
  // Orden: SMC (estructura + liquidez con nombre) → pools/barridos (usan esos
  // niveles) → setups (usan pools, clusters de liquidaciones y muros como objetivos)
  if (typeof btcComputeSMC === 'function') btcComputeSMC();
  BTC.liq = btcLiquidity(row);
  if (typeof btcSmcSetups === 'function') btcSmcSetups();
  const F = [];
  const add = (name, score, weight, reason) =>
    F.push({ name, score: Math.max(-1, Math.min(1, score)), weight, reason });
  const n = v => v ?? 0;
  const fp = fmtPrice;

  // 1) Flujo de dinero (25)
  {
    let s = 0; const why = [];
    if (n(row.oi1h) > 0.15 && n(row.price1hPct) > 0)      { s += 0.6; why.push(`OI 1h ${fmtPct(row.oi1h)} con precio subiendo = dinero nuevo LONG`); }
    else if (n(row.oi1h) > 0.15 && n(row.price1hPct) < 0) { s -= 0.6; why.push(`OI 1h ${fmtPct(row.oi1h)} con precio cayendo = dinero nuevo SHORT`); }
    else if (n(row.oi1h) < -0.15 && n(row.price1hPct) > 0){ s += 0.3; why.push(`OI cayendo con precio subiendo = cierre de cortos (squeeze)`); }
    else if (n(row.oi1h) < -0.15 && n(row.price1hPct) < 0){ s -= 0.3; why.push(`OI cayendo con precio cayendo = desapalancamiento`); }
    else why.push('OI 1h plano — sin entrada clara de dinero');
    const vol5m = n(row.vol1hUSD) / 12;
    if (row.cvd5m != null && vol5m > 0) {
      if (row.cvd5m >  vol5m * 0.08) { s += 0.3; why.push(`CVD comprador (${'+' }${fmtUSD(row.cvd5m)} en 5m)`); }
      if (row.cvd5m < -vol5m * 0.08) { s -= 0.3; why.push(`CVD vendedor (−${fmtUSD(Math.abs(row.cvd5m))} en 5m)`); }
    }
    if (n(row.fundingRate) >  0.03) { s -= 0.2; why.push(`funding alto (${row.fundingRate.toFixed(4)}%): longs sobreextendidos`); }
    if (n(row.fundingRate) < -0.01) { s += 0.2; why.push(`funding negativo: shorts pagando`); }
    add('💰 Flujo de dinero', s, 25, why.join(' · '));
  }

  // 2) Long/Short ratio (15) — lectura contrarian del retail
  if (BTC.ls?.buyRatio != null) {
    const b = BTC.ls.buyRatio;
    const s = (0.5 - b) * 5; // retail 60% long → −0.5 (combustible bajista)
    const trend = BTC.ls.prevBuyRatio != null ? b - BTC.ls.prevBuyRatio : 0;
    add('⚖️ Long/Short ratio', s, 15,
      `${(b * 100).toFixed(1)}% de cuentas en LONG${trend > 0.01 ? ' (y subiendo)' : trend < -0.01 ? ' (y bajando)' : ''} — ` +
      (b > 0.56 ? 'retail cargado de longs: sus stops abajo son combustible BAJISTA'
        : b < 0.44 ? 'retail cargado de shorts: sus stops arriba son combustible ALCISTA'
        : 'equilibrado, sin ventaja contrarian'));
  } else add('⚖️ Long/Short ratio', 0, 15, 'cargando ratio de Bybit…');

  // 2b) Top traders — dinero grande: se SIGUE, no contrarian. Fuente CoinGlass
  //     si tu plan lo incluye; si no, el endpoint PÚBLICO de Binance Futures
  //     (mismo dato, gratis). Si ninguna responde, la tarjeta no aparece.
  {
    const src = BTC.cg?.top ? { ...BTC.cg.top, lbl: 'CoinGlass' }
              : BTC.free?.topLS ? { ...BTC.free.topLS, lbl: 'Binance público' } : null;
    if (src) {
      const t = src.longPct;
      const d = t - (src.prev ?? t);
      add('🐋 Top traders', (t - 50) / 12, 12,
        `top traders de Binance ${t.toFixed(1)}% en LONG${Math.abs(d) >= 0.5 ? (d > 0 ? ' y aumentando' : ' y reduciendo') : ''} — el dinero grande está ${t > 52 ? 'comprado' : t < 48 ? 'vendido' : 'neutral'} · fuente: ${src.lbl}`);
    }
  }

  // 3) Barridos de liquidez (15)
  {
    const L = BTC.liq;
    const lowTxt  = s => s.key ? `el ${s.key} (${fp(s.level)})` : `el mínimo de ${fp(s.level)}`;
    const highTxt = s => s.key ? `el ${s.key} (${fp(s.level)})` : `el máximo de ${fp(s.level)}`;
    if (L?.sweptLow && (!L.sweptHigh || L.sweptLow.barsAgo <= L.sweptHigh.barsAgo)) {
      add('🧹 Barrido de liquidez', L.sweptLow.key ? 1 : 0.9, 15, `se barrió ${lowTxt(L.sweptLow)} hace ${L.sweptLow.barsAgo * 15} min y RECUPERÓ — stop hunt bajista completado, típico giro ALCISTA`);
    } else if (L?.sweptHigh) {
      add('🧹 Barrido de liquidez', L.sweptHigh.key ? -1 : -0.9, 15, `se barrió ${highTxt(L.sweptHigh)} hace ${L.sweptHigh.barsAgo * 15} min y RECHAZÓ — stop hunt alcista completado, típico giro BAJISTA`);
    } else {
      add('🧹 Barrido de liquidez', 0, 15, 'sin barridos recientes (últimas 2h) — la liquidez sigue intacta');
    }
  }

  // 3b) Estructura SMC (12) — jerarquía mayor/interna + premium/discount.
  //     La estructura MAYOR (swings ±8 velas) manda la dirección; la interna
  //     (±3) matiza: si contradice a la mayor con un CHoCH reciente es un
  //     retroceso/posible giro en desarrollo y el score se amortigua.
  //     El equilibrium añade contexto de precio: comprar en discount y vender
  //     en premium suma; perseguir precio en la zona contraria resta.
  {
    const smc = BTC.smc;
    const maj = smc?.major?.events;
    if (maj && maj.length) {
      const last = maj[maj.length - 1];
      const k = btcChartData();
      const nBars = k?.c?.length || 0;
      const barsAgo = nBars - 1 - last.i;
      const up = last.dir === 'up';
      let s = up ? 0.7 : -0.7;
      if (last.type === 'CHoCH') s *= 1.25;
      if (barsAgo > 32) s *= 0.4; // mayor de ~8h: pesa mucho menos
      let txt = `${last.type} mayor ${up ? 'ALCISTA' : 'BAJISTA'} hace ${barsAgo * 15}min en ${fp(last.price)}` +
        (last.type === 'CHoCH' ? ' — cambio de carácter en la estructura mayor' : ' — continuación de la estructura mayor') +
        (smc.tf === '1h' ? ' · análisis en 1h' : '');

      // Interna: ¿acompaña o contradice?
      const intE = smc.internal?.events;
      if (intE?.length) {
        const li = intE[intE.length - 1];
        const liAgo = nBars - 1 - li.i;
        if (liAgo <= 12) { // interna reciente (~3h)
          if ((li.dir === 'up') === up) { s *= 1.1; txt += ' · interna alineada'; }
          else if (li.type === 'CHoCH') { s *= 0.55; txt += ` · ⚠ CHoCH interno ${li.dir === 'up' ? 'alcista' : 'bajista'} hace ${liAgo * 15}min — retroceso/posible giro en desarrollo`; }
          else { s *= 0.8; txt += ' · interna corrigiendo'; }
        }
      }

      // Equilibrium: contexto de zona (comprar barato / vender caro)
      const eq = smc.eq;
      if (eq) {
        const prem = eq.posPct >= 50;
        txt += ` · precio en ${prem ? 'PREMIUM' : 'DISCOUNT'} (${eq.posPct.toFixed(0)}% del rango mayor)`;
        if (up && !prem) { s *= 1.15; txt += ' — largo en zona barata ✓'; }
        else if (!up && prem) { s *= 1.15; txt += ' — corto en zona cara ✓'; }
        else if (up && eq.posPct > 75) { s *= 0.8; txt += ' — ojo: perseguir largos en zona cara'; }
        else if (!up && eq.posPct < 25) { s *= 0.8; txt += ' — ojo: perseguir cortos en zona barata'; }
      }

      // Contexto 4h (de arriba hacia abajo): a favor refuerza, en contra recorta
      const htf = BTC.htf;
      if (htf?.trend && htf.trend !== 'NEUTRAL') {
        const htfUp = htf.trend === 'up';
        if (htfUp === up) { s *= 1.2; txt += ` · 4h ${htfUp ? 'alcista' : 'bajista'} a favor ✓`; }
        else { s *= 0.6; txt += ` · ⚠ contra la 4h (${htfUp ? 'alcista' : 'bajista'}${htf.last ? ` desde ${htf.last.type} en ${fp(htf.last.price)}` : ''}) — probable retroceso dentro de la tendencia mayor`; }
        if (htf.eq) txt += ` · 4h en ${htf.eq.posPct >= 50 ? 'premium' : 'discount'} ${htf.eq.posPct.toFixed(0)}%`;
      }
      add('🧠 Estructura SMC', Math.max(-1, Math.min(1, s)), 12, txt);
    } else add('🧠 Estructura SMC', 0, 12, 'sin rupturas de estructura mayor (BOS/CHoCH) claras en el historial analizado');
  }

  // 3c) Setup SMC activo (10): barrido + CHoCH + zona de entrada. Solo cuenta
  //     mientras está armado o con el precio en la zona; la nota escala el voto.
  {
    const act = BTC.smc?.setups?.active?.filter(s => s.state === 'armado' || s.state === 'en zona') || [];
    const s0 = act.sort((a, b) => b.pts - a.pts)[0];
    if (s0) {
      const sign = s0.dir === 'long' ? 1 : -1;
      add('🎯 Setup SMC', sign * (0.35 + 0.15 * s0.pts), 10,
        `${s0.dir === 'long' ? 'LARGO' : 'CORTO'} ${s0.grade} ${s0.state === 'en zona' ? 'con el precio EN LA ZONA' : 'armado, esperando retroceso'}: ` +
        `barrió ${s0.level?.key || (s0.level?.kind === 'eq' ? 'iguales' : 'swing')} ${fp(s0.level.price)} + ${s0.chochType} · zona ${fp(s0.zBot)}–${fp(s0.zTop)} · stop ${fp(s0.stop)} · T1 ${fp(s0.t1)} · R:R ${s0.rr.toFixed(1)}`);
    }
  }

  // 4) Liquidez pendiente / imanes (15). Por orden de preferencia:
  //    a) mapa de liquidaciones propio (btcliq.js, OI de Bybit+Binance)
  //    b) heatmap de CoinGlass (si algún día el plan lo incluye)
  //    c) inferencia estructural (equal highs/lows sin barrer)
  //    En los tres, el imán es el cluster gordo y CERCANO: tamaño / distancia.
  const LM = BTC.liqm;
  const pullOf = c => c ? c.usd / Math.max(Math.abs(c.level - row.price) / row.price, 0.002) : 0;
  const near = arr => (arr || []).filter(c => Math.abs(c.level - row.price) / row.price <= 0.04);
  if (LM && (near(LM.above).length || near(LM.below).length)) {
    const up = near(LM.above), dn = near(LM.below);
    const pUp = up.reduce((a, c) => a + pullOf(c), 0), pDn = dn.reduce((a, c) => a + pullOf(c), 0);
    const s = (pUp - pDn) / Math.max(pUp + pDn, 1) * 0.9;
    const d = c => `${fmtUSD(c.usd)} en ${fp(c.level)} (${c.level > row.price ? '+' : '−'}${(Math.abs(c.level - row.price) / row.price * 100).toFixed(2)}%)`;
    const parts = [];
    if (up[0]) parts.push(`cortos por liquidar arriba: ${d(up.sort((a, b) => pullOf(b) - pullOf(a))[0])}`);
    if (dn[0]) parts.push(`largos por liquidar abajo: ${d(dn.sort((a, b) => pullOf(b) - pullOf(a))[0])}`);
    add('🧲 Imanes de liquidación', s, 15,
      `${parts.join(' · ')} — el imán dominante está ${pUp >= pDn ? 'ARRIBA' : 'ABAJO'} · en ±3%: ${fmtUSD(LM.shortUSD3)} cortos / ${fmtUSD(LM.longUSD3)} largos · modelo propio (OI Bybit${LM.srcs.binance ? '+Binance' : ''})`);
  } else {
    const cl = BTC.cg?.clusters;
    if (cl && (cl.above || cl.below)) {
      // atracción = tamaño del cluster / distancia (el imán gordo y cercano manda)
      const pull = c => c ? c.usd / Math.max(Math.abs(c.level - row.price) / row.price, 0.001) : 0;
      const pUp = pull(cl.above), pDn = pull(cl.below);
      const s = (pUp - pDn) / Math.max(pUp + pDn, 1) * 0.9;
      const parts = [];
      if (cl.above) parts.push(`${fmtUSD(cl.above.usd)} pendientes en ${fp(cl.above.level)} (+${((cl.above.level - row.price) / row.price * 100).toFixed(2)}%)`);
      if (cl.below) parts.push(`${fmtUSD(cl.below.usd)} en ${fp(cl.below.level)} (−${((row.price - cl.below.level) / row.price * 100).toFixed(2)}%)`);
      add('🧲 Imanes de liquidación', s, 15, `heatmap CoinGlass (24h, modelo de CoinGlass): ${parts.join(' · ')} — el imán dominante está ${pUp >= pDn ? 'ARRIBA' : 'ABAJO'}`);
    } else {
      const L = BTC.liq;
      const up = L?.poolsAbove?.[0], dn = L?.poolsBelow?.[0];
      const tag = BTC.cg?.err?.hm ? ' · estructura propia (equal highs/lows)' : '';
      if (up && dn) {
        const dUp = (up.level - row.price) / row.price;
        const dDn = (row.price - dn.level) / row.price;
        const s = (dDn - dUp) / Math.max(dUp + dDn, 0.0001) * 0.8; // pool más cercano atrae
        add('🧲 Imanes de liquidez', s, 15,
          `pools sin barrer: arriba ${fp(up.level)} (+${(dUp * 100).toFixed(2)}%) · abajo ${fp(dn.level)} (−${(dDn * 100).toFixed(2)}%) — el imán más cercano está ${dUp < dDn ? 'ARRIBA' : 'ABAJO'}${tag}`);
      } else if (up) {
        add('🧲 Imanes de liquidez', 0.6, 15, `solo queda liquidez sin barrer ARRIBA en ${fp(up.level)} — imán alcista${tag}`);
      } else if (dn) {
        add('🧲 Imanes de liquidez', -0.6, 15, `solo queda liquidez sin barrer ABAJO en ${fp(dn.level)} — imán bajista${tag}`);
      } else {
        add('🧲 Imanes de liquidez', 0, 15, 'sin equal highs/lows claros en 24h' + tag);
      }
    }
  }

  // 5) Muros de order book (10) — 5 libros combinados (btcbook.js). Vota el
  //    desequilibrio bids/asks en ±1 % y, sobre todo, los muros CERCANOS (≤0,8 %):
  //    un muro de compra justo debajo es soporte; uno de venta justo encima, techo.
  if (BTC.ob?.mid) {
    const ob = BTC.ob;
    const dist = w => Math.abs(w.price - row.price) / row.price;
    const nearW = arr => (arr || []).filter(w => dist(w) <= 0.008).sort((a, b) => dist(a) - dist(b))[0];
    const bw = nearW(ob.bidWalls), aw = nearW(ob.askWalls);
    const imb = (ob.bidUSD - ob.askUSD) / Math.max(ob.bidUSD + ob.askUSD, 1);
    let s = imb * 1.5;
    if (bw) s += 0.35 * Math.min(1, bw.str / 5);
    if (aw) s -= 0.35 * Math.min(1, aw.str / 5);
    const age = w => w.first ? `, lleva ${Math.max(1, Math.round((Date.now() - w.first) / 60_000))} min` : '';
    const wTxt = (w, kind) => `${kind} ${fmtUSD(w.usd)} en ${fp(w.lo)}–${fp(w.hi)} (${w.price >= row.price ? '+' : '−'}${(dist(w) * 100).toFixed(2)}% · ${btcBookSrcTxt(w.src)}${age(w)})`;
    const parts = [];
    if (bw) parts.push(wTxt(bw, bw.weak ? 'zona densa de compra cerca' : 'muro de COMPRA cerca'));
    else if (ob.bidWalls?.[0]) parts.push(wTxt(ob.bidWalls[0], ob.bidWalls[0].weak ? 'zona densa de compra' : 'mayor muro de compra'));
    if (aw) parts.push(wTxt(aw, aw.weak ? 'zona densa de venta cerca' : 'muro de VENTA cerca'));
    else if (ob.askWalls?.[0]) parts.push(wTxt(ob.askWalls[0], ob.askWalls[0].weak ? 'zona densa de venta' : 'mayor muro de venta'));
    parts.push(`±1%: bids ${fmtUSD(ob.bidUSD)} vs asks ${fmtUSD(ob.askUSD)} (${imb >= 0 ? '+' : ''}${(imb * 100).toFixed(0)}% hacia ${imb >= 0 ? 'compras' : 'ventas'})`);
    const nEx = Object.values(ob.exch || {}).filter(Boolean).length;
    parts.push(`${nEx}/5 libros`);
    add('🧱 Muros order book', s, 10, parts.join(' · '));
  } else add('🧱 Muros order book', 0, 10, 'cargando order book de Bybit, Binance, OKX e Hyperliquid…');

  // 6) Max pain de opciones (10) — Deribit vía CoinGlass si está disponible
  //    (mercado dominante de opciones); si no, calculado de la cadena de Bybit
  {
    const mpSrc = BTC.cg?.mp?.price ? { ...BTC.cg.mp, src: 'Deribit·CG' } : BTC.mp?.price ? { ...BTC.mp, src: 'Bybit' } : null;
    if (mpSrc) {
      const dist = (mpSrc.price - row.price) / row.price;
      const daysToExp = Math.max(0, (mpSrc.expiryTs - Date.now()) / 86_400_000);
      const wScale = daysToExp <= 1 ? 1 : daysToExp <= 3 ? 0.6 : 0.25; // pesa más cerca del vencimiento
      const pcrTxt = mpSrc.pcr != null ? ` · put/call ${mpSrc.pcr.toFixed(2)} (${mpSrc.pcr > 1 ? 'defensivo' : 'optimista'})` : '';
      add('🎯 Max pain (opciones)', Math.max(-1, Math.min(1, dist * 30)) * wScale, 10,
        `max pain ${mpSrc.src} del vencimiento ${mpSrc.expiry} en ${fp(mpSrc.price)} (${dist >= 0 ? '+' : ''}${(dist * 100).toFixed(2)}% desde aquí)` +
        (daysToExp <= 1 ? ' — vence HOY: gravedad fuerte hacia ese nivel' : ` — vence en ${daysToExp.toFixed(1)}d`) + pcrTxt);
    } else add('🎯 Max pain (opciones)', 0, 10, 'calculando con la cadena de opciones…');
  }

  // 7) Basis perp-spot (10) — premium = euforia, descuento = miedo (contrarian)
  if (BTC.spot?.basisPct != null) {
    const b = BTC.spot.basisPct;
    add('📐 Basis perp-spot', Math.max(-1, Math.min(1, -b * 12)), 10,
      `perp ${b >= 0 ? 'premium' : 'descuento'} de ${b.toFixed(3)}% vs spot — ` +
      (b > 0.04 ? 'apalancamiento long caro/eufórico (riesgo de flush)' : b < -0.02 ? 'perp con descuento: miedo, suele ser suelo' : 'neutral'));
  } else add('📐 Basis perp-spot', 0, 10, 'comparando spot vs perp…');

  // 8) Coinbase Premium (peso 8) — demanda institucional americana real.
  //    CoinGlass si está; si no, CALCULADO en vivo (Coinbase spot vs Binance spot).
  {
    const src = BTC.cg?.cbp ? { rate: BTC.cg.cbp.rate, prev: BTC.cg.cbp.prevAvg, lbl: 'CoinGlass 4h' }
              : BTC.free?.prem ? { rate: BTC.free.prem.rate, prev: BTC.free.prem.prevRate ?? BTC.free.prem.rate, lbl: 'calculado en vivo' } : null;
    if (src) {
      const r = src.rate;
      const rising  = r > src.prev + 0.005;
      const falling = r < src.prev - 0.005;
      add('🇺🇸 Coinbase Premium', Math.max(-1, Math.min(1, r * 12)), 8,
        `premium ${r >= 0 ? '+' : ''}${r.toFixed(3)}% vs Binance${rising ? ' y subiendo' : falling ? ' y bajando' : ''} — ` +
        (r > 0.03 ? 'institucionales americanos COMPRANDO spot en Coinbase' : r < -0.03 ? 'institucionales VENDIENDO en Coinbase' : 'sin presión institucional clara') +
        ` · fuente: ${src.lbl}`);
    }
  }

  // 9) Flujos ETF (peso 8) — solo con CoinGlass (no hay fuente gratuita fiable);
  //    si el plan no lo incluye, la tarjeta simplemente no aparece.
  if (BTC.cg?.etf) {
    const f = BTC.cg.etf.lastFlow, s3 = BTC.cg.etf.sum3;
    add('🏦 Flujos ETF (CG)', Math.max(-1, Math.min(1, f / 500e6 * 0.7 + s3 / 1500e6 * 0.3)), 8,
      `último día ${f >= 0 ? '+' : '−'}${fmtUSD(Math.abs(f))} · acumulado 3d ${s3 >= 0 ? '+' : '−'}${fmtUSD(Math.abs(s3))} — ` +
      (f > 100e6 ? 'los ETF están absorbiendo BTC (demanda estructural)' : f < -100e6 ? 'salidas de los ETF (presión estructural)' : 'flujo neutro'));
  }

  // 10) Agresión spot vs perp (peso 10) — las divergencias anticipan squeezes.
  //     CoinGlass multi-exchange si está; si no, los últimos ~1000 trades de
  //     Bybit en spot y perp (ventana corta pero en vivo).
  {
    const src = BTC.cg?.taker ? { ...BTC.cg.taker, lbl: 'CoinGlass Binance+OKX+Bybit ~8h' }
              : BTC.free?.taker ? { ...BTC.free.taker, lbl: 'Bybit en vivo, ventana corta' } : null;
    if (src) {
      const { spot, fut } = src;
      let s, why;
      if (spot > 0.52 && fut < 0.48)      { s = 0.9;  why = 'SPOT comprando mientras PERPS venden — divergencia clásica de squeeze ALCISTA'; }
      else if (spot < 0.48 && fut > 0.52) { s = -0.9; why = 'PERPS comprando mientras SPOT vende — rally apalancado sin respaldo real, riesgo de flush'; }
      else if (spot > 0.52 && fut > 0.52) { s = 0.5;  why = 'compra agresiva en spot y perps a la vez — demanda amplia'; }
      else if (spot < 0.48 && fut < 0.48) { s = -0.5; why = 'venta agresiva en spot y perps a la vez — distribución amplia'; }
      else { s = (spot + fut - 1) * 3; why = 'sin dominancia clara de agresión'; }
      add('🔀 Spot vs Perp', s, 10,
        `taker buy: spot ${(spot * 100).toFixed(1)}% · perps ${(fut * 100).toFixed(1)}% (${src.lbl}) — ${why}`);
    }
  }

  BTC.factors = F;
  // Normalizado por la suma de pesos activos: el sesgo se mantiene en −100..+100
  // aunque haya factores extra (CoinGlass) o alguno caído (peso 0 = solo informativo)
  const wSum = F.reduce((a, f) => a + f.weight, 0) || 1;
  const total = F.reduce((a, f) => a + f.score * f.weight, 0) / wSum * 100;
  BTC.bias = Math.round(total);
  BTC.prob = Math.max(5, Math.min(95, Math.round(50 + BTC.bias / 2)));
  BTC.dir  = BTC.bias >= 15 ? 'ALCISTA' : BTC.bias <= -15 ? 'BAJISTA' : 'NEUTRAL';

  // Alerta al cambiar la dirección del sesgo
  if (BTC.lastDir && BTC.dir !== 'NEUTRAL' && BTC.dir !== BTC.lastDir && canAlert('btcBias')) {
    showToast(`₿ Sesgo BTC → ${BTC.dir} (${BTC.prob}%)`, BTC.dir === 'ALCISTA' ? 'long' : 'short');
    playAlertSound('btcBias', BTC.dir === 'ALCISTA' ? 'long' : 'short');
    notifyDesktop(`₿ BTC cambió a ${BTC.dir}`, `Probabilidad ${BTC.prob}% — abre la pestaña BTC para ver los factores`);
  }
  if (BTC.dir !== 'NEUTRAL') BTC.lastDir = BTC.dir;
}

// ── Sesiones ────────────────────────────────────────────────────────────────
function btcSessionInfo() {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const marks = BTC_SESSIONS.map(s => ({ ...s, ts: todayUTC + (s.utcH * 60 + s.utcM) * 60_000 }));
  let current = marks[marks.length - 1]; // por defecto la última de ayer (NY)
  for (const m of marks) if (Date.now() >= m.ts) current = m;
  let next = marks.find(m => m.ts > Date.now());
  if (!next) next = { ...marks[0], ts: marks[0].ts + 86_400_000 };
  return { current, next, msToNext: next.ts - Date.now() };
}

function btcSnapshotSessions() {
  const row = allRows.find(r => r.symbol === 'BTC');
  if (!row || !BTC.factors.length) return;
  const { current } = btcSessionInfo();
  const dayKey = new Date().toISOString().slice(0, 10);
  const id = `${dayKey}|${current.key}`;
  let snaps = JSON.parse(localStorage.getItem('scalp_btc_sess') || '[]');
  if (!snaps.some(s => s.id === id)) {
    snaps.push({ id, key: current.key, ts: Date.now(), bias: BTC.bias, prob: BTC.prob, dir: BTC.dir, price: row.price });
    if (snaps.length > 12) snaps = snaps.slice(-12);
    safeSetItem('scalp_btc_sess', JSON.stringify(snaps));
  }
}

// ── Render ──────────────────────────────────────────────────────────────────
function renderBTC() {
  const el = document.getElementById('btc-tab');
  const row = allRows.find(r => r.symbol === 'BTC');
  if (!el) return;
  if (!row || !BTC.factors.length) { el.innerHTML = '<div class="lr-empty" style="padding:30px">Cargando datos de BTC…</div>'; return; }

  const { current, next, msToNext } = btcSessionInfo();
  const hh = Math.floor(msToNext / 3600_000), mm = Math.floor(msToNext % 3600_000 / 60_000);
  const dirCol = BTC.dir === 'ALCISTA' ? '#2fe08a' : BTC.dir === 'BAJISTA' ? '#ff5555' : '#8aa0c8';
  const fp = fmtPrice;

  // Razones del veredicto: factores con |score×peso| relevante, ordenados por aporte
  const reasons = [...BTC.factors]
    .filter(f => Math.abs(f.score * f.weight) >= 3)
    .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
    .map(f => `<div class="btc-reason"><span style="color:${f.score > 0 ? '#2fe08a' : f.score < 0 ? '#ff6666' : '#8aa0c8'}">${f.score > 0 ? '▲' : f.score < 0 ? '▼' : '·'}</span> ${f.reason}</div>`)
    .join('') || '<div class="btc-reason">Sin factores con señal clara ahora mismo — mejor esperar.</div>';

  // Escalera de niveles clave (de mayor a menor precio). Solo lo que está a
  // ±4 % (salvo el max pain): lo lejano no sirve para un scalp y ensucia la lista.
  const L = BTC.liq || {};
  const lvls = [];
  const srcTag = w => typeof btcBookSrcTxt === 'function' ? ` · ${btcBookSrcTxt(w.src)}` : '';
  for (const p of (L.poolsAbove || [])) lvls.push({ price: p.level, label: '🧲 pool de liquidez (equal highs sin barrer)', col: '#4aa8d8' });
  for (const w of (BTC.ob?.askWalls || []).slice(0, 3)) lvls.push({ price: w.price, label: `🧱 ${w.weak ? 'zona densa de venta' : 'muro de VENTA'} ${fmtUSD(w.usd)}${srcTag(w)}`, col: '#ff8866' });
  for (const w of (BTC.ob?.bidWalls || []).slice(0, 3)) lvls.push({ price: w.price, label: `🧱 ${w.weak ? 'zona densa de compra' : 'muro de COMPRA'} ${fmtUSD(w.usd)}${srcTag(w)}`, col: '#55dd99' });
  for (const p of (L.poolsBelow || [])) lvls.push({ price: p.level, label: '🧲 pool de liquidez (equal lows sin barrer)', col: '#4aa8d8' });
  for (const c of (BTC.liqm?.above || []).slice(0, 2)) lvls.push({ price: c.level, label: `🔥 cortos por liquidar ${fmtUSD(c.usd)} (modelo)`, col: '#f5d76e' });
  for (const c of (BTC.liqm?.below || []).slice(0, 2)) lvls.push({ price: c.level, label: `🔥 largos por liquidar ${fmtUSD(c.usd)} (modelo)`, col: '#f5d76e' });
  for (const kl of (BTC.smc?.keyLevels || [])) if (!kl.swept) lvls.push({ price: kl.price, label: `💧 ${kl.key} (liquidez sin barrer)`, col: '#c9a7ff' });
  for (const sl of (typeof btcSmcSetupLevels === 'function' ? btcSmcSetupLevels() : [])) lvls.push({ price: sl.v, label: sl.label, col: sl.col });
  for (const sh of btcShotLevels()) lvls.push({ price: sh.price, label: `📸 CoinGlass: ${sh.label}`, col: '#ff7ad9' });
  const mpL = BTC.cg?.mp?.price ? { ...BTC.cg.mp, src: ' · Deribit' } : BTC.mp?.price ? { ...BTC.mp, src: '' } : null;
  if (BTC.cg?.clusters?.above) lvls.push({ price: BTC.cg.clusters.above.level, label: `🔥 cluster de liquidaciones ${fmtUSD(BTC.cg.clusters.above.usd)} (heatmap CG)`, col: '#ff9a3c' });
  if (BTC.cg?.clusters?.below) lvls.push({ price: BTC.cg.clusters.below.level, label: `🔥 cluster de liquidaciones ${fmtUSD(BTC.cg.clusters.below.usd)} (heatmap CG)`, col: '#ff9a3c' });
  const inRange = lvls.filter(l => Math.abs(l.price - row.price) / row.price <= 0.04);
  if (mpL) inRange.push({ price: mpL.price, label: `🎯 max pain opciones (${mpL.expiry})${mpL.src}`, col: '#ffd76a' });
  inRange.push({ price: row.price, label: '● PRECIO ACTUAL', col: '#e8edf8', now: true });
  inRange.sort((a, b) => b.price - a.price);
  const ladder = inRange.map(l => {
    const d = (l.price - row.price) / row.price * 100;
    return `<div class="btc-lvl${l.now ? ' btc-lvl-now' : ''}">
      <b style="color:${l.col}">${fp(l.price)}</b>
      <span class="btc-lvl-label" style="color:${l.col}">${l.label}</span>
      <span class="btc-lvl-dist">${l.now ? '' : (d >= 0 ? '+' : '') + d.toFixed(2) + '%'}</span>
    </div>`;
  }).join('');

  // Tarjetas de factores
  const cards = BTC.factors.map(f => {
    const val = f.score * f.weight;
    const col = f.score > 0.1 ? '#2fe08a' : f.score < -0.1 ? '#ff6666' : '#8aa0c8';
    return `<div class="btc-factor">
      <div class="btc-factor-head">
        <span>${f.name}</span>
        <b style="color:${col}">${val >= 0 ? '+' : ''}${val.toFixed(0)}</b>
        <span class="btc-factor-w">peso ${f.weight}</span>
      </div>
      <div class="btc-factor-bar"><div style="width:${Math.abs(f.score) * 50}%;margin-left:${f.score >= 0 ? 50 : 50 - Math.abs(f.score) * 50}%;background:${col}"></div></div>
      <div class="btc-factor-reason">${f.reason}</div>
    </div>`;
  }).join('');

  // Historial de sesiones
  const snaps = JSON.parse(localStorage.getItem('scalp_btc_sess') || '[]').slice(-6).reverse();
  const sessRows = snaps.map(s => {
    const move = (row.price - s.price) / s.price * 100;
    const hit = s.dir === 'NEUTRAL' ? null : (s.dir === 'ALCISTA') === (move > 0);
    return `<div class="btc-sess-row">
      <span>${s.id.slice(5, 10)} · <b>${s.key}</b></span>
      <span style="color:${s.dir === 'ALCISTA' ? '#2fe08a' : s.dir === 'BAJISTA' ? '#ff5555' : '#8aa0c8'}">${s.dir} ${s.prob}%</span>
      <span>@ ${fp(s.price)}</span>
      <span class="${move >= 0 ? 'pos' : 'neg'}">${move >= 0 ? '+' : ''}${move.toFixed(2)}% desde apertura</span>
      <span>${hit == null ? '—' : hit ? '✅' : '❌'}</span>
    </div>`;
  }).join('') || '<span class="lr-empty">Los snapshots se guardan solos al abrir cada sesión.</span>';

  const gaugePos = (BTC.bias + 100) / 2;
  el.innerHTML = `
    <div class="btc-top">
      <div class="btc-verdict" style="border-color:${dirCol}50">
        <div class="btc-verdict-head">
          <span class="btc-verdict-prob" style="color:${dirCol}">${BTC.prob}%</span>
          <span class="btc-verdict-dir" style="color:${dirCol}">${BTC.dir}</span>
          <span class="btc-verdict-price">${fp(row.price)}</span>
          <span class="btc-sess">Sesión: <b>${current.key}</b> · ${next.key} en ${hh}h ${mm}m</span>
        </div>
        <div class="btc-gauge"><div class="btc-gauge-marker" style="left:${gaugePos}%"></div></div>
        <div class="btc-gauge-labels"><span>BAJISTA −100</span><span>0</span><span>+100 ALCISTA</span></div>
        <div class="btc-reasons">${reasons}</div>
      </div>
      <div class="btc-ladder">
        <div class="dt-sec-title">Niveles clave ahora</div>
        ${ladder}
      </div>
    </div>
    <div class="btc-chart-wrap${localStorage.getItem('scalp_btc_big') === '1' ? ' expanded' : ''}">
      <canvas id="btc-chart"></canvas>
      <div class="dt-chart-hint" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="chart-tf-btn" id="btc-expand-btn" onclick="btcToggleExpand()">${localStorage.getItem('scalp_btc_big') === '1' ? '⛶ Compactar' : '⛶ Expandir'}</button>
        <button class="chart-tf-btn${typeof _btcSmcOn !== 'undefined' && _btcSmcOn ? ' active' : ''}" id="btc-smc-btn" onclick="btcToggleSMC()" title="Smart Money Concepts: estructura mayor (chips BOS/CHoCH) e interna (triángulos), order blocks (★ = desplazamiento, ★★ = además barrió liquidez), breakers (BRK), FVG, equilibrium 50% y el setup activo">🧠 SMC</button>
        <button class="chart-tf-btn${typeof _btcSmcTf !== 'undefined' && _btcSmcTf === '1h' ? ' active' : ''}" id="btc-smc-tf-btn" onclick="btcToggleSMCTf()" title="Temporalidad del análisis SMC: 15m (rápida) o 1h (estructura más fiable, proyectada sobre las velas 15m)">⏱ ${typeof _btcSmcTf !== 'undefined' ? _btcSmcTf : '15m'}</button>
        <button class="chart-tf-btn${_btcHeat !== 'off' ? ' active' : ''}" id="btc-heat-btn" onclick="btcCycleHeat()" title="Mapa de calor de fondo: 🔥 liquidaciones pendientes estimadas (amarillo = mucha liquidez) · 🧱 historial del order book (verde azulado = compras, naranja = ventas; se graba mientras la app está abierta) · apagado">${BTC_HEAT_LBL[_btcHeat]}</button>
        <button class="chart-tf-btn" onclick="btcYZoom(1)" title="Ver más rango de precio arriba y abajo (también: Shift+rueda, o rueda sobre la columna de precios)">↕ +</button>
        <button class="chart-tf-btn" onclick="btcYZoom(-1)" title="Ver menos rango de precio (acercar en vertical)">↕ −</button>
        <span id="btc-yz-lbl" style="color:#afb6c0;font-weight:700">${!_btcView.yFix && _btcView.yZoom > 1.01 ? '×' + _btcView.yZoom.toFixed(1) : ''}</span>
        <button class="chart-tf-btn${_btcView.yFix ? ' active' : ''}" id="btc-yfix-btn" onclick="btcYFix()" title="Encuadrar el precio ±4 %: donde se buscan los muros y los clusters de liquidaciones más cercanos. Otro clic: rango automático">${_btcView.yFix ? `🎯 precio ±${(_btcView.yFix * 100).toFixed(1)}%` : '🎯 ver ±4%'}</button>
        <button class="chart-tf-btn" onclick="btcShotPick()" title="Leer una captura del Liquidation Heatmap (o Liquidation Map) de CoinGlass: sus niveles se dibujan en rosa durante 12 h. También puedes pegarla con Ctrl+V o arrastrarla a esta pestaña.">📸 Captura CoinGlass</button>
        <span><b style="color:#afb6c0">rueda: zoom · Shift+rueda o rueda sobre los precios: zoom vertical · arrastrar: mover (también arriba/abajo) · doble clic: reiniciar</b> · velas 15m (hasta ~10 días)</span>
        <span><span style="color:#4aa8d8">— 🧲 pools</span> · <span style="color:#55dd99">— 🧱 compra</span> · <span style="color:#ff8866">— 🧱 venta</span> · <span style="color:#f5d76e">— 🔥 liquidaciones</span> · <span style="color:#c9a7ff">— 💧 PDH/PDL/Asia/Londres</span> · <span style="color:#ffd76a">— 🎯 max pain</span> · <span style="color:#ff7ad9">— 📸 CoinGlass</span> · ⚡ barrido · verticales = sesiones</span>
        <span><span style="color:#2fe08a">— OB/FVG alcista</span> · <span style="color:#ff6666">— OB/FVG bajista</span> · BRK = breaker · <span style="color:#eef4ff;background:#0b0e14;padding:0 3px;border-radius:2px">texto BOS/CHoCH/OB</span> siempre en blanco: el borde del chip indica la dirección</span>
      </div>
      ${_btcShotMsg ? `<div class="btc-shot-msg">${_btcShotMsg}</div>` : ''}
    </div>
    <div class="btc-cards">
      ${btcSetupCard(row)}
      ${btcBookCard(row)}
      ${btcLiqCard(row)}
    </div>
    <div class="dt-sec-title" style="margin-top:4px">Factores de confluencia — sesgo total ${BTC.bias >= 0 ? '+' : ''}${BTC.bias}/100</div>
    <div class="btc-factors">${cards}</div>
    <div class="dt-sec-title" style="margin-top:4px">📅 Snapshots por sesión — ¿acertó el sesgo?</div>
    <div class="btc-sessions">${sessRows}</div>
    <div class="cc-note">${(() => {
      const cg = [];
      if (BTC.ob?.exch) {
        const e = BTC.ob.exch;
        cg.push(`🧱 muros: ${(typeof BOOK_SRC !== 'undefined' ? BOOK_SRC : []).map(x => x.lbl + (e[x.key] ? '✓' : '✗')).join(' · ')}`);
      }
      if (BTC.liqm) cg.push(`🔥 liquidaciones: modelo propio (OI Bybit${BTC.liqm.srcs.binance ? '+Binance' : ''}${BTC.liqm.srcs.taker ? ', taker Binance' : ''})`);
      const st = (cgOk, freeOk, name) => cgOk ? `${name} CG✓` : freeOk ? `${name} gratis✓` : `${name} ✗`;
      cg.push(st(BTC.cg?.top, BTC.free?.topLS, '🐋 top traders'));
      cg.push(BTC.cg?.mp ? '🎯 max pain Deribit✓' : BTC.mp?.price ? '🎯 max pain Bybit✓' : '🎯 max pain ✗');
      cg.push(BTC.cg?.clusters ? '🔥 heatmap CG✓' : '🔥 heatmap CG ✗ (tu plan no lo incluye)');
      cg.push(st(BTC.cg?.cbp, BTC.free?.prem, '🇺🇸 premium'));
      cg.push(BTC.cg?.etf ? '🏦 ETF CG✓' : '🏦 ETF ✗ (solo CoinGlass)');
      cg.push(st(BTC.cg?.taker, BTC.free?.taker, '🔀 spot/perp'));
      cg.push(BTC.cg?.liqHist?.length ? '▮ liqs CG✓' : '▮ liqs Bybit en vivo✓');
      return `Pesos normalizados sobre los factores activos — lo que no tiene datos NO aparece ni diluye el sesgo. Muros: order book combinado de 5 libros pedido directo desde el navegador. Fuentes: ${cg.join(' · ')}. "gratis✓" = respaldo público (Binance/Coinbase/Bybit) cuando tu plan de CoinGlass no cubre el módulo.`;
    })()}</div>`;

  requestAnimationFrame(() => {
    drawBTCChart(row);
    btcBindChart(document.getElementById('btc-chart'));
  });
}

// ── Gráfico de velas 15m con TODOS los niveles analizados dibujados ─────────
// Historial extendido (~10 días) + zoom con la rueda, arrastre para moverse,
// doble clic para volver a "hoy" y botón ⛶ para expandir la altura.
let _btcView = {
  span: parseInt(localStorage.getItem('scalp_btc_span') || '96', 10), offset: 0,
  // vertical: yZoom ×rango automático · yOff desplazamiento · yFix rango fijo ±% del precio
  yZoom: Math.max(1, Math.min(10, parseFloat(localStorage.getItem('scalp_btc_yzoom') || '1') || 1)), yOff: 0, yFix: null,
};

// ── Zoom vertical: ver más (o menos) precio por arriba y por abajo ───────────
function _btcRedraw() { const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row); btcYBtnRefresh(); }
function btcYZoom(dir) { // dir > 0 = más rango (alejar), < 0 = menos (acercar)
  const f = dir > 0 ? 1.4 : 1 / 1.4;
  if (_btcView.yFix) _btcView.yFix = Math.max(0.003, Math.min(0.15, _btcView.yFix * f));
  else _btcView.yZoom = Math.max(1, Math.min(10, (_btcView.yZoom || 1) * f));
  safeSetItem('scalp_btc_yzoom', String(_btcView.yZoom));
  _btcRedraw();
}
// Encuadra precio ±4 %: la zona donde se buscan los muros (±3 %) y los clusters
// de liquidaciones más cercanos. Segundo clic: vuelve al rango automático.
function btcYFix() {
  _btcView.yFix = _btcView.yFix ? null : 0.04;
  _btcView.yOff = 0;
  _btcRedraw();
}
function btcYBtnRefresh() {
  const b = document.getElementById('btc-yfix-btn');
  if (b) {
    b.classList.toggle('active', !!_btcView.yFix);
    b.textContent = _btcView.yFix ? `🎯 precio ±${(_btcView.yFix * 100).toFixed(1)}%` : '🎯 ver ±4%';
  }
  const z = document.getElementById('btc-yz-lbl');
  if (z) z.textContent = _btcView.yFix ? '' : (_btcView.yZoom > 1.01 ? `×${_btcView.yZoom.toFixed(1)}` : '');
}
let _btcDrag = null;

function btcChartData() {
  if (BTC.k15x?.k?.c?.length) return BTC.k15x.k;
  return allRows.find(r => r.symbol === 'BTC')?.k15 || null;
}

// Velas 15m extendidas: 1000 velas ≈ 10.4 días (una sola llamada cada 5 min)
async function btcFetchK15x() {
  BTC.k15x = { ...(BTC.k15x || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=1000');
    const list = r.result?.list || [];
    if (list.length < 50) return;
    BTC.k15x = {
      ts: Date.now(),
      k: {
        t: list.map(x => +x[0]).reverse(),
        o: list.map(x => parseFloat(x[1])).reverse(),
        h: list.map(x => parseFloat(x[2])).reverse(),
        l: list.map(x => parseFloat(x[3])).reverse(),
        c: list.map(x => parseFloat(x[4])).reverse(),
        v: list.map(x => parseFloat(x[5])).reverse(),
      },
    };
    if (typeof btcLiqCompute === 'function') btcLiqCompute(); // el modelo va indexado a estas velas
    if (activeTab === 'btc') { const row = allRows.find(r2 => r2.symbol === 'BTC'); if (row) drawBTCChart(row); }
  } catch (_) {}
}

function btcToggleExpand() {
  const wrap = document.querySelector('.btc-chart-wrap');
  if (!wrap) return;
  const big = wrap.classList.toggle('expanded');
  safeSetItem('scalp_btc_big', big ? '1' : '0');
  const btn = document.getElementById('btc-expand-btn');
  if (btn) btn.textContent = big ? '⛶ Compactar' : '⛶ Expandir';
  const row = allRows.find(r => r.symbol === 'BTC');
  if (row) requestAnimationFrame(() => drawBTCChart(row));
}

// Zoom (rueda) · pan (arrastre) · reset (doble clic). Se re-vincula en cada
// render porque el canvas se reconstruye — usar propiedades on* lo hace idempotente.
//
// El arrastre (mousemove/mouseup) se escucha en `document`, NO en el canvas:
// si solo se escucha en el canvas, en cuanto el mouse sale de sus bordes
// mientras arrastras (muy fácil, el canvas no es toda la pantalla) el
// onmouseleave cortaba el drag de inmediato — se sentía como que "no se
// puede arrastrar". Los listeners de document se enlazan UNA sola vez
// (_btcDragBound) para no acumular duplicados en cada render.
let _btcDragBound = false;
function btcBindChart(canvas) {
  if (!canvas) return;
  const plotW = () => canvas.getBoundingClientRect().width - 216;
  canvas.style.cursor = 'crosshair';
  canvas.onwheel = e => {
    e.preventDefault();
    const k = btcChartData(); if (!k) return;
    // Vertical: con Shift, o con el ratón sobre la columna de precios/etiquetas.
    // (En Windows, Shift+rueda llega como deltaX: se acepta cualquiera de los dos.)
    const rectV = canvas.getBoundingClientRect();
    if (e.shiftKey || e.clientX - rectV.left > rectV.width - 210) {
      const d = e.deltaY || e.deltaX;
      if (d) btcYZoom(d > 0 ? 1 : -1);
      return;
    }
    const n = k.c.length;
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    const newSpan = Math.round(Math.max(40, Math.min(n, _btcView.span * factor)));
    const rect = canvas.getBoundingClientRect();
    const frac = 1 - Math.max(0, Math.min(1, (e.clientX - rect.left - 6) / plotW())); // fracción desde el borde derecho
    const anchor = _btcView.offset + frac * _btcView.span; // vela bajo el cursor (en barras desde la derecha)
    _btcView.offset = Math.round(Math.max(0, Math.min(n - newSpan, anchor - frac * newSpan)));
    _btcView.span = newSpan;
    safeSetItem('scalp_btc_span', String(newSpan));
    const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row);
  };
  canvas.onmousedown = e => {
    e.preventDefault();
    _btcDrag = { x: e.clientX, y: e.clientY, offset: _btcView.offset, yOff: _btcView.yOff || 0, vert: false };
    canvas.style.cursor = 'grabbing';
  };
  canvas.ondblclick = () => {
    _btcView = { span: 96, offset: 0, yZoom: 1, yOff: 0, yFix: null };
    safeSetItem('scalp_btc_span', '96');
    safeSetItem('scalp_btc_yzoom', '1');
    btcYBtnRefresh();
    const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row);
  };

  if (!_btcDragBound) {
    _btcDragBound = true;
    document.addEventListener('mousemove', e => {
      if (!_btcDrag) return;
      const cv = document.getElementById('btc-chart'); if (!cv) return;
      const k = btcChartData(); if (!k) return;
      const pw = cv.getBoundingClientRect().width - 216;
      const pxPerBar = pw / _btcView.span;
      const dBars = Math.round((e.clientX - _btcDrag.x) / pxPerBar);
      _btcView.offset = Math.max(0, Math.min(k.c.length - _btcView.span, _btcDrag.offset + dBars));
      // Arrastre vertical (con zona muerta de 6 px para no moverlo sin querer
      // al arrastrar en horizontal): el contenido sigue al ratón.
      const dy = e.clientY - _btcDrag.y;
      if (!_btcDrag.vert && Math.abs(dy) > 6) _btcDrag.vert = true;
      if (_btcDrag.vert) {
        const plotH = Math.max(50, cv.getBoundingClientRect().height - 34);
        const z = _btcView.yFix ? 1 : Math.max(1, _btcView.yZoom || 1);
        _btcView.yOff = _btcDrag.yOff + dy * z / plotH;
      }
      cv.style.cursor = 'grabbing';
      const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row);
    });
    document.addEventListener('mouseup', () => {
      _btcDrag = null;
      const cv = document.getElementById('btc-chart'); if (cv) cv.style.cursor = 'crosshair';
    });
  }
}

// ── Fibonacci automático: ancla al máximo y mínimo del rango VISIBLE (s0..s1,
// igual que el "Auto Fib Retracement" de TradingView — al hacer zoom/pan
// cambia qué tramo de tendencia se mide). 0% = el extremo más RECIENTE
// (el máximo si la tendencia acaba de hacer techo, el mínimo si acaba de
// hacer suelo) · 100% = el extremo más viejo, de donde arrancó el impulso.
const FIB_RATIOS = [
  { r: 0,     label: '0%',    key: false },
  { r: 0.382, label: '38.2%', key: true  },
  { r: 0.5,   label: '50%',   key: true  },
  { r: 0.618, label: '61.8%', key: true  },
  { r: 1,     label: '100%',  key: false },
];
function btcFibLevels(k, s0, s1) {
  let hi = -Infinity, hiI = -1, lo = Infinity, loI = -1;
  for (let i = s0; i < s1; i++) {
    if (k.h[i] > hi) { hi = k.h[i]; hiI = i; }
    if (k.l[i] < lo) { lo = k.l[i]; loI = i; }
  }
  if (hiI < 0 || loI < 0 || hi <= lo) return [];
  const up = hiI > loI; // el máximo es más reciente que el mínimo → tendencia alcista hacia ese techo
  const recent = up ? hi : lo, start = up ? lo : hi;
  return FIB_RATIOS.map(f => ({
    v: recent - (recent - start) * f.r,
    col: f.key ? '#f0b90b' : 'rgba(240,185,11,0.55)',
    dash: f.key ? [] : [3, 3],
    label: `Fib ${f.label}${f.r === 0 ? (up ? ' (máx)' : ' (mín)') : f.r === 1 ? (up ? ' (mín)' : ' (máx)') : ''}`,
  }));
}

// ── Alerta: BTC entra en la "zona dorada" del Fibonacci (50%–61.8%) ─────────
// Usa el MISMO rango visible (_btcView) que el gráfico, aunque no esté en
// pantalla — así la alerta siempre coincide con lo que se vería al abrir la
// pestaña ₿. Solo dispara al ENTRAR a la zona (no en cada ciclo mientras sigue
// dentro), igual que el patrón ya usado para el cambio de sesgo (btcBias).
let _btcInGoldenZone = false;
function btcCheckFibZone() {
  const fp = fmtPrice;
  const row = allRows.find(r => r.symbol === 'BTC');
  const k = btcChartData();
  if (!row || !k || k.c.length < 10) { _btcInGoldenZone = false; return; }
  const n = k.c.length;
  const s1 = Math.max(1, n - _btcView.offset), s0 = Math.max(0, s1 - _btcView.span);
  const fib = btcFibLevels(k, s0, s1);
  const f50 = fib.find(f => f.label === 'Fib 50%');
  const f618 = fib.find(f => f.label === 'Fib 61.8%');
  if (!f50 || !f618) { _btcInGoldenZone = false; return; }
  const lo = Math.min(f50.v, f618.v), hi = Math.max(f50.v, f618.v);
  const inside = row.price >= lo && row.price <= hi;
  if (inside && !_btcInGoldenZone && canAlert('btcFib')) {
    const dirTag = fib[0].label.includes('máx') ? 'long' : 'short'; // retroceso hacia abajo=vigilar rebote LONG · hacia arriba=vigilar rechazo SHORT
    showToast(`🟡 BTC entró en la zona dorada del Fib (${fp(lo)}–${fp(hi)}) — vigila ${dirTag === 'long' ? 'rebote LONG' : 'rechazo SHORT'}`, dirTag);
    playAlertSound('btcFib', dirTag);
    notifyDesktop('🟡 BTC en zona dorada del Fibonacci', `Precio ${fp(row.price)} entre 50%–61.8% (${fp(lo)}–${fp(hi)}) — abre la pestaña BTC`);
  }
  _btcInGoldenZone = inside;
}

function drawBTCChart(row) {
  const canvas = document.getElementById('btc-chart');
  const k = btcChartData();
  if (!canvas || !k || k.c.length < 10) return;

  const W = canvas.width = canvas.clientWidth || 900;
  const H = canvas.height = canvas.clientHeight || 330;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const n = k.c.length;
  const PADL = 6, PADR = 210, PADT = 16, PADB = 18;

  // ── Ventana visible (zoom/pan) ──
  _btcView.span = Math.max(40, Math.min(n, _btcView.span || 96));
  _btcView.offset = Math.max(0, Math.min(n - _btcView.span, _btcView.offset));
  const s1 = n - _btcView.offset; // exclusivo (borde derecho)
  const s0 = s1 - _btcView.span;  // inclusivo (borde izquierdo)

  // ── Recolectar niveles analizados ──
  const L = BTC.liq || {};
  const levels = [];
  // (El Fibonacci automático ya no se dibuja: lo pidió el usuario el 2026-11-06.
  //  btcFibLevels sigue existiendo para la alerta de zona dorada, btcCheckFibZone.)
  for (const p of (L.poolsAbove || [])) levels.push({ v: p.level, col: '#4aa8d8', dash: [5, 4], label: '🧲 pool liquidez' });
  for (const p of (L.poolsBelow || [])) levels.push({ v: p.level, col: '#4aa8d8', dash: [5, 4], label: '🧲 pool liquidez' });
  const wSrc = w => typeof btcBookSrcTxt === 'function' ? ` ${btcBookSrcTxt(w.src).split(' · ')[0] || ''}` : '';
  for (const w of (BTC.ob?.askWalls || []).slice(0, 3)) levels.push({ v: w.price, col: '#ff8866', dash: w.weak ? [3, 3] : [], label: `🧱 ${w.weak ? 'densa' : 'venta'} ${fmtUSD(w.usd)}${wSrc(w)}` });
  for (const w of (BTC.ob?.bidWalls || []).slice(0, 3)) levels.push({ v: w.price, col: '#55dd99', dash: w.weak ? [3, 3] : [], label: `🧱 ${w.weak ? 'densa' : 'compra'} ${fmtUSD(w.usd)}${wSrc(w)}` });
  // 🔥 clusters del modelo de liquidaciones (los 2 mayores por lado)
  for (const c of (BTC.liqm?.above || []).slice(0, 2)) levels.push({ v: c.level, col: '#f5d76e', dash: [2, 3], label: `🔥 cortos ${fmtUSD(c.usd)}` });
  for (const c of (BTC.liqm?.below || []).slice(0, 2)) levels.push({ v: c.level, col: '#f5d76e', dash: [2, 3], label: `🔥 largos ${fmtUSD(c.usd)}` });
  // 💧 liquidez con nombre aún sin barrer (PDH/PDL, PWH/PWL, Asia, Londres)
  for (const kl of (BTC.smc?.keyLevels || [])) if (!kl.swept) levels.push({ v: kl.price, col: '#c9a7ff', dash: [2, 4], label: `💧 ${kl.key}` });
  // 🎯 entrada/stop/objetivos del setup SMC activo (solo con el overlay SMC encendido)
  if (typeof _btcSmcOn !== 'undefined' && _btcSmcOn && typeof btcSmcSetupLevels === 'function') levels.push(...btcSmcSetupLevels());
  // 📸 niveles leídos de una captura de CoinGlass
  for (const sh of btcShotLevels()) levels.push({ v: sh.price, col: '#ff7ad9', dash: [6, 3], label: `📸 CG ${Math.round((sh.intensity || 0) * 100)}%` });
  const mpL = BTC.cg?.mp?.price ? BTC.cg.mp : BTC.mp;
  if (mpL?.price) levels.push({ v: mpL.price, col: '#ffd76a', dash: [8, 4], label: `🎯 max pain ${mpL.expiry}` });
  if (BTC.cg?.clusters?.above) levels.push({ v: BTC.cg.clusters.above.level, col: '#ff9a3c', dash: [2, 3], label: `🔥 liqs ${fmtUSD(BTC.cg.clusters.above.usd)}` });
  if (BTC.cg?.clusters?.below) levels.push({ v: BTC.cg.clusters.below.level, col: '#ff9a3c', dash: [2, 3], label: `🔥 liqs ${fmtUSD(BTC.cg.clusters.below.usd)}` });

  // ── Rango: velas visibles + niveles que caen dentro (o cerca) de ese rango ──
  let minC = Infinity, maxC = -Infinity;
  for (let i = s0; i < s1; i++) { minC = Math.min(minC, k.l[i]); maxC = Math.max(maxC, k.h[i]); }
  const rp = (maxC - minC) * 0.06 || maxC * 0.001;
  const nearby = levels.filter(l => l.v >= minC - rp && l.v <= maxC + rp);
  let min = minC, max = maxC;
  for (const l of nearby) { min = Math.min(min, l.v); max = Math.max(max, l.v); }
  const pad = (max - min) * 0.04 || max * 0.001;
  min -= pad; max += pad;

  // ── Zoom/desplazamiento VERTICAL (Shift+rueda, rueda sobre los precios,
  //    arrastrar arriba/abajo, botones ↕). yZoom amplía el rango automático
  //    alrededor de su centro; yOff lo desplaza (en fracciones del rango base).
  //    Con yFix (botón ±4%) el rango se ancla al precio actual: price ±yFix.
  {
    const lp0 = row.price || k.c[n - 1];
    const base = max - min, mid0 = (min + max) / 2;
    _btcView.yBase = base; // lo usa el arrastre vertical para convertir px → precio
    if (_btcView.yFix) {
      const half = lp0 * _btcView.yFix;
      const c = lp0 + (_btcView.yOff || 0) * half * 2;
      min = c - half; max = c + half;
    } else {
      const z = Math.max(1, _btcView.yZoom || 1);
      const c = mid0 + (_btcView.yOff || 0) * base;
      min = c - base * z / 2; max = c + base * z / 2;
    }
  }
  // Con más rango entran niveles que antes quedaban fuera: se dibujan todos los del rango final
  const shown = levels.filter(l => l.v >= min && l.v <= max);

  // Deja ~3 velas de espacio vacío a la derecha antes de la franja de
  // etiquetas, para que la última vela no quede pegada al texto (barrido, muro, etc.)
  const RIGHT_MARGIN_BARS = 3;
  const x = i => PADL + (i - s0) / Math.max(1, _btcView.span - 1 + RIGHT_MARGIN_BARS) * (W - PADL - PADR);
  const y = v => PADT + (max - v) / (max - min) * (H - PADT - PADB);

  // ── Grid + eje de precios ──
  ctx.font = '9px Inter,system-ui';
  for (let g = 0; g <= 5; g++) {
    const v = min + (max - min) * g / 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PADL, y(v)); ctx.lineTo(W - PADR, y(v)); ctx.stroke();
    // eje de precios pegado al borde derecho, fuera de la zona de etiquetas
    ctx.fillStyle = '#26334a'; ctx.textAlign = 'right';
    ctx.fillText(fmtPrice(v).replace('$', ''), W - 4, y(v) + 3);
  }

  // ── Mapa de calor de fondo (recortado al área de velas) ──
  if (_btcHeat !== 'off') {
    ctx.save();
    ctx.beginPath(); ctx.rect(PADL, PADT, W - PADL - PADR, H - PADT - PADB); ctx.clip();
    if (_btcHeat === 'liq' && typeof btcDrawLiqHeat === 'function') btcDrawLiqHeat(ctx, x, y, s0, s1, k, min, max);
    else if (_btcHeat === 'book' && typeof btcDrawBookHeat === 'function') btcDrawBookHeat(ctx, x, y, s0, s1, k);
    ctx.restore();
  }

  // ── Aperturas de sesión (líneas verticales, todos los días visibles) ──
  const dayFirst = Math.floor(k.t[s0] / 86_400_000) * 86_400_000;
  const showSessLabels = _btcView.span <= 300; // con mucho zoom-out las etiquetas estorban
  for (let d = dayFirst; d <= k.t[s1 - 1]; d += 86_400_000) {
    for (const s of BTC_SESSIONS) {
      const ts = d + (s.utcH * 60 + s.utcM) * 60_000;
      if (ts < k.t[s0] || ts > k.t[s1 - 1]) continue;
      let idx = -1;
      for (let i = s0; i < s1; i++) if (k.t[i] >= ts) { idx = i; break; }
      if (idx < 0) continue;
      ctx.save();
      ctx.strokeStyle = 'rgba(120,140,180,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(x(idx), PADT); ctx.lineTo(x(idx), H - PADB); ctx.stroke();
      ctx.setLineDash([]);
      if (showSessLabels) {
        ctx.fillStyle = 'rgba(120,140,180,0.5)'; ctx.font = '8.5px Inter,system-ui'; ctx.textAlign = 'center';
        ctx.fillText(s.key, x(idx), PADT - 4);
      }
      ctx.restore();
    }
  }

  // ── Smart Money Concepts: zonas de OB/FVG DETRÁS de las velas ──
  if (typeof smcDrawZones === 'function') smcDrawZones(ctx, x, y, s0, s1);

  // ── Velas (solo las visibles) ──
  const bw = Math.max(1.2, (W - PADL - PADR) / _btcView.span * 0.66);
  for (let i = s0; i < s1; i++) {
    const up = k.c[i] >= k.o[i];
    const col = up ? '#1fae74' : '#d24a4a';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(k.h[i])); ctx.lineTo(x(i), y(k.l[i])); ctx.stroke();
    ctx.fillStyle = col;
    const yo = y(k.o[i]), yc = y(k.c[i]);
    ctx.fillRect(x(i) - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  }

  // ── Smart Money Concepts: rupturas de estructura (BOS/CHoCH) sobre las velas ──
  if (typeof smcDrawStructure === 'function') smcDrawStructure(ctx, x, y, s0, s1);

  // ── Banda de liquidaciones (parte baja del gráfico) ──────────────────────
  // CoinGlass agregado multi-exchange (4h) si tu plan lo incluye; si no, las
  // liquidaciones REALES capturadas en vivo del WS de Bybit (por vela de 15m,
  // persistidas ~10 días). Rojo = largos liquidados · verde = cortos liquidados.
  {
    const liqBars = [];
    if (BTC.cg?.liqHist?.length) {
      for (const e of BTC.cg.liqHist) {
        if (e.t < k.t[s0] || e.t > k.t[s1 - 1]) continue;
        let idx = -1;
        for (let i = s0; i < s1; i++) if (k.t[i] >= e.t) { idx = i; break; }
        if (idx >= 0) liqBars.push({ i: idx, l: e.l, s: e.s });
      }
    } else {
      for (let i = s0; i < s1; i++) {
        const b = _btcLiqB[k.t[i]];
        if (b && (b.l || b.s)) liqBars.push({ i, l: b.l, s: b.s });
      }
    }
    const BAND = 26, base = H - PADB - 2;
    if (liqBars.length) {
      const maxV = Math.max(...liqBars.map(b => Math.max(b.l, b.s)), 1);
      const colW = Math.max(1.2, bw * 0.45);
      for (const b of liqBars) {
        const hL = Math.max(b.l > 0 ? 2 : 0, Math.sqrt(b.l / maxV) * BAND);
        const hS = Math.max(b.s > 0 ? 2 : 0, Math.sqrt(b.s / maxV) * BAND);
        ctx.globalAlpha = 0.6;
        if (hL > 0) { ctx.fillStyle = '#d24a4a'; ctx.fillRect(x(b.i) - colW, base - hL, colW, hL); }
        if (hS > 0) { ctx.fillStyle = '#1fae74'; ctx.fillRect(x(b.i) + 0.5, base - hS, colW, hS); }
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = 'rgba(120,140,180,0.5)'; ctx.font = '8px Inter,system-ui'; ctx.textAlign = 'left';
      ctx.fillText(`▮ liquidaciones ${BTC.cg?.liqHist?.length ? 'CoinGlass 4h' : 'Bybit en vivo 15m'} · rojo=largos · verde=cortos`, PADL + 4, base - BAND - 4);
    } else {
      // Sin datos aún: dejar constancia de que la banda existe y se está llenando
      ctx.fillStyle = 'rgba(120,140,180,0.35)'; ctx.font = '8px Inter,system-ui'; ctx.textAlign = 'left';
      ctx.fillText('▮ liquidaciones: acumulando en vivo del WS de Bybit… (CoinGlass no disponible en tu plan)', PADL + 4, base - 4);
    }
  }

  // ── Niveles analizados: línea + etiqueta con FONDO (chip) apilada sin taparse ──
  // Si no caben todas las etiquetas (rango muy abierto), se rotulan las más
  // cercanas al precio y las demás quedan solo como línea.
  const lpLbl = row.price || k.c[n - 1];
  const slots = Math.max(4, Math.floor((H - PADT - PADB) / 15));
  const keepLbl = new Set([...shown].sort((a, b) => Math.abs(a.v - lpLbl) - Math.abs(b.v - lpLbl)).slice(0, slots));
  for (const l of shown) {
    if (keepLbl.has(l)) continue;
    const ly0 = y(l.v);
    ctx.save();
    ctx.strokeStyle = l.col; ctx.lineWidth = 1; ctx.globalAlpha = 0.45;
    if (l.dash.length) ctx.setLineDash(l.dash);
    ctx.beginPath(); ctx.moveTo(PADL, ly0); ctx.lineTo(W - PADR, ly0); ctx.stroke();
    ctx.restore();
  }
  const sorted = [...keepLbl].sort((a, b) => b.v - a.v);
  ctx.font = '700 9.5px Inter,system-ui';
  const labelX = W - PADR + 8;
  const labelMaxW = PADR - 66; // deja libre el eje de precios del borde derecho
  // Posiciones de las etiquetas en dos pasadas: de arriba abajo (nunca a <15 px
  // de la anterior) y, si la pila se sale por abajo, de abajo arriba empujándola
  // hacia arriba — antes las últimas se amontonaban encima unas de otras.
  const lyPos = [];
  for (let i = 0; i < sorted.length; i++) lyPos[i] = Math.max(y(sorted[i].v), i ? lyPos[i - 1] + 15 : PADT - 1);
  for (let i = sorted.length - 1; i >= 0; i--) lyPos[i] = Math.min(lyPos[i], i < sorted.length - 1 ? lyPos[i + 1] - 15 : H - PADB - 4);
  for (let li = 0; li < sorted.length; li++) {
    const l = sorted[li];
    const ly0 = y(l.v);
    // línea del nivel
    ctx.save();
    ctx.strokeStyle = l.col; ctx.lineWidth = 1.3;
    if (l.dash.length) ctx.setLineDash(l.dash);
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(PADL, ly0); ctx.lineTo(W - PADR, ly0); ctx.stroke();
    ctx.restore();

    const ly = lyPos[li];

    // si no cabe, se acorta la DESCRIPCIÓN pero el precio siempre queda completo
    const priceTxt = fmtPrice(l.v).replace('$', '');
    let lbl = l.label;
    let txt = `${lbl} · ${priceTxt}`;
    while (lbl.length > 4 && ctx.measureText(txt).width > labelMaxW) {
      lbl = lbl.slice(0, -2);
      txt = `${lbl}… · ${priceTxt}`;
    }
    const tw2 = ctx.measureText(txt).width;

    // conector nivel → etiqueta
    ctx.strokeStyle = l.col; ctx.globalAlpha = 0.5; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(W - PADR, ly0); ctx.lineTo(labelX - 3, ly); ctx.stroke();
    ctx.globalAlpha = 1;

    // chip de fondo para que nada se tape
    ctx.fillStyle = 'rgba(4,6,10,0.94)';
    ctx.fillRect(labelX - 3, ly - 8, tw2 + 10, 15);
    ctx.strokeStyle = l.col; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    ctx.strokeRect(labelX - 3, ly - 8, tw2 + 10, 15);
    ctx.globalAlpha = 1;
    ctx.fillStyle = l.col; ctx.textAlign = 'left';
    ctx.fillText(txt, labelX + 2, ly + 3);
  }

  // ── Barridos recientes (⚡ en la vela donde se cazaron los stops) ──
  ctx.font = '900 12px Inter,system-ui'; ctx.textAlign = 'center';
  if (L.sweptLow) {
    const i = n - 1 - L.sweptLow.barsAgo;
    if (i >= s0 && i < s1) {
      ctx.fillStyle = '#2fe08a';
      ctx.fillText('⚡', x(i), y(L.sweptLow.level) + 16);
      ctx.font = '700 8px Inter,system-ui';
      ctx.fillText('barrido', x(i), y(L.sweptLow.level) + 26);
      ctx.font = '900 12px Inter,system-ui';
    }
  }
  if (L.sweptHigh) {
    const i = n - 1 - L.sweptHigh.barsAgo;
    if (i >= s0 && i < s1) {
      ctx.fillStyle = '#ff6666';
      ctx.fillText('⚡', x(i), y(L.sweptHigh.level) - 8);
      ctx.font = '700 8px Inter,system-ui';
      ctx.fillText('barrido', x(i), y(L.sweptHigh.level) - 18);
      ctx.font = '900 12px Inter,system-ui';
    }
  }

  // ── Eje de tiempo (fecha·hora en 5 marcas) ──
  ctx.fillStyle = '#2e3c50'; ctx.font = '8.5px Inter,system-ui'; ctx.textAlign = 'center';
  for (let g = 0; g <= 4; g++) {
    const i = Math.round(s0 + (s1 - 1 - s0) * g / 4);
    const d = new Date(k.t[i]);
    ctx.fillText(
      d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
      Math.max(PADL + 28, Math.min(W - PADR - 28, x(i))), H - 5);
  }

  // ── Precio actual: chip blanco en el BORDE DERECHO (zona del eje, sin tapar
  //    las etiquetas de niveles que viven en la franja izquierda del margen) ──
  const lp = row.price || k.c[n - 1];
  if (lp >= min && lp <= max) {
    const lpTxt = fmtPrice(lp).replace('$', '');
    ctx.font = '800 10px Inter,system-ui';
    const tw = ctx.measureText(lpTxt).width;
    ctx.save();
    ctx.strokeStyle = 'rgba(232,237,248,0.7)'; ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(PADL, y(lp)); ctx.lineTo(W - tw - 12, y(lp)); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#e8edf8';
    ctx.fillRect(W - tw - 10, y(lp) - 8, tw + 8, 15);
    ctx.fillStyle = '#0b0e14'; ctx.textAlign = 'right';
    ctx.fillText(lpTxt, W - 6, y(lp) + 4);
  }

  // Indicador de zoom (esquina superior izquierda)
  ctx.fillStyle = 'rgba(120,140,180,0.45)'; ctx.font = '8.5px Inter,system-ui'; ctx.textAlign = 'left';
  const hrs = _btcView.span * 0.25;
  ctx.fillText(`${hrs < 48 ? hrs.toFixed(0) + 'h' : (hrs / 24).toFixed(1) + 'd'} visibles${_btcView.offset ? ' · ←' + (_btcView.offset * 0.25).toFixed(0) + 'h del presente' : ''}`, PADL + 4, PADT + 8);
}

// ── Mapa de calor de fondo: liquidaciones (modelo) · libro (historial) · off ─
const BTC_HEAT_LBL = { liq: '🔥 Mapa: liquidaciones', book: '🧱 Mapa: libro', off: '◻ Mapa: apagado' };
let _btcHeat = (() => {
  try { const v = localStorage.getItem('scalp_btc_heat'); return BTC_HEAT_LBL[v] ? v : 'liq'; } catch (_) { return 'liq'; }
})();
function btcCycleHeat() {
  _btcHeat = _btcHeat === 'liq' ? 'book' : _btcHeat === 'book' ? 'off' : 'liq';
  safeSetItem('scalp_btc_heat', _btcHeat);
  const btn = document.getElementById('btc-heat-btn');
  if (btn) { btn.textContent = BTC_HEAT_LBL[_btcHeat]; btn.classList.toggle('active', _btcHeat !== 'off'); }
  const row = allRows.find(r => r.symbol === 'BTC');
  if (row) drawBTCChart(row);
}

const _btcEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Tarjeta: setup SMC activo + historial ───────────────────────────────────
function btcSetupCard(row) {
  const fp = fmtPrice;
  const S = BTC.smc?.setups;
  const act = S?.active || [];
  const pctFrom = (a, b) => (Math.abs(a - b) / b * 100).toFixed(2) + '%';
  const ck = (ok, txt) => `<span class="btc-ck ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${txt}</span>`;
  const lvlName = s => s.level?.key || (s.level?.kind === 'eq' ? 'máx/mín iguales' : 'swing');

  const items = act.map(s => {
    const col = s.dir === 'long' ? '#2fe08a' : '#ff6666';
    const lado = s.dir === 'long' ? 'LARGO' : 'CORTO';
    const ago = Math.max(0, Math.round((S.nBars - 1 - s.sweepI) * 15));
    if (s.state === 'barrido' || s.zTop == null) {
      return `<div class="btc-setup" style="border-color:${col}33">
        <div class="btc-setup-head"><b style="color:${col}">${lado}</b><span class="btc-setup-state">👀 fase 1 de 3: barrido hecho, falta el CHoCH</span></div>
        <div class="btc-setup-steps">💧 barrió ${lvlName(s)} ${fp(s.level.price)} hace ${ago} min (extremo ${fp(s.sweepExt)}). Se arma si llega un CHoCH interno ${s.dir === 'long' ? 'alcista' : 'bajista'} sin perder ${fp(s.sweepExt)}.</div>
      </div>`;
    }
    // Confluencias del libro y del mapa de liquidaciones alrededor del setup
    const extra = [];
    const inZone = w => w.price >= Math.min(s.stop, s.zBot) * 0.999 && w.price <= Math.max(s.stop, s.zTop) * 1.001;
    const wall = (s.dir === 'long' ? BTC.ob?.bidWalls : BTC.ob?.askWalls)?.find(inZone);
    if (wall) extra.push(`🧱 muro de ${s.dir === 'long' ? 'compra' : 'venta'} de ${fmtUSD(wall.usd)} en ${fp(wall.price)} defendiendo la zona`);
    const risk = (s.dir === 'long' ? BTC.liqm?.below : BTC.liqm?.above)?.find(c => Math.abs(c.level - s.stop) / s.stop < 0.005 && (s.dir === 'long' ? c.level < s.stop : c.level > s.stop));
    if (risk) extra.push(`⚠ ${fmtUSD(risk.usd)} de ${s.dir === 'long' ? 'largos' : 'cortos'} por liquidar en ${fp(risk.level)}, justo detrás del stop: el precio puede ir a buscarlos`);
    const tgt = (s.dir === 'long' ? BTC.liqm?.above : BTC.liqm?.below)?.find(c => Math.abs(c.level - s.t1) / s.t1 < 0.004 || (s.t2 && Math.abs(c.level - s.t2) / s.t2 < 0.004));
    if (tgt) extra.push(`🔥 objetivo con ${fmtUSD(tgt.usd)} de ${s.dir === 'long' ? 'cortos' : 'largos'} por liquidar en ${fp(tgt.level)}`);
    return `<div class="btc-setup${s.state === 'en zona' ? ' hot' : ''}" style="border-color:${col}66">
      <div class="btc-setup-head">
        <b style="color:${col}">${lado} ${s.grade}</b>
        <span class="btc-setup-state">${s.state === 'en zona' ? '🟢 PRECIO EN LA ZONA' : '⏳ armado · esperando retroceso'}</span>
        <span class="btc-setup-rr">R:R ${s.rr.toFixed(1)}</span>
      </div>
      <div class="btc-setup-steps">✓ barrió ${lvlName(s)} ${fp(s.level.price)} (hace ${ago} min) → ✓ ${s.chochType} interno en ${fp(s.chochPrice)} → ${s.state === 'en zona' ? '✓' : '⏳'} retroceso al OB</div>
      <div class="btc-setup-grid">
        <span>Zona</span><b>${fp(s.zBot)} – ${fp(s.zTop)}</b>
        <span>Entrada (50%)</span><b>${fp(s.entry)} <i>${row.price >= s.entry ? '−' : '+'}${pctFrom(s.entry, row.price)} desde aquí</i></b>
        <span>Stop</span><b style="color:#ff4d6d">${fp(s.stop)} <i>${pctFrom(s.stop, s.entry)} de la entrada</i></b>
        <span>T1</span><b style="color:#2fe08a">${fp(s.t1)} <i>${pctFrom(s.t1, s.entry)}</i></b>
        ${s.t2 != null ? `<span>T2</span><b style="color:#2fe08a">${fp(s.t2)} <i>${pctFrom(s.t2, s.entry)}</i></b>` : ''}
      </div>
      <div class="btc-setup-checks">${ck(s.checks.htf, '4h a favor')}${ck(s.checks.discount, s.dir === 'long' ? 'zona en discount' : 'zona en premium')}${ck(s.checks.liq, 'liquidez con nombre o iguales')}${ck(s.checks.disp, 'desplazamiento (FVG)')}</div>
      ${extra.length ? `<div class="btc-setup-extra">${extra.join('<br>')}</div>` : ''}
    </div>`;
  }).join('');

  const hist = (typeof btcSmcSetupHistory === 'function' ? btcSmcSetupHistory() : [])
    .filter(h => !['armado', 'en zona'].includes(h.state)).slice(-6).reverse();
  const stTxt = h => h.state === 'objetivo' ? `✅ T1 (+${(h.rr || 0).toFixed(1)}R)` : h.state === 'stop' ? '❌ stop (−1R)'
    : h.state === 'sin retroceso' ? '↗ se fue sin retroceso' : h.state === 'caducado' ? '⌛ caducó sin entrar' : '✗ invalidado';
  const histHtml = hist.map(h => {
    const d = new Date(h.ts);
    return `<div class="btc-setup-hist"><span>${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</span>
      <b style="color:${h.dir === 'long' ? '#2fe08a' : '#ff6666'}">${h.dir === 'long' ? 'L' : 'S'} ${h.grade}</b><span>${_btcEsc(h.key)}</span><span>${stTxt(h)}</span></div>`;
  }).join('');

  return `<div class="btc-card">
    <div class="dt-sec-title">🎯 Setup SMC · 15m · barrido → CHoCH → OB</div>
    ${items || `<div class="btc-card-empty">Sin setup activo. Se busca: <b>1)</b> barrido de liquidez (PDH/PDL, Asia, Londres, semana, máximos/mínimos iguales o swings) con cierre de vuelta · <b>2)</b> CHoCH interno a favor · <b>3)</b> retroceso al order block del impulso. Avisa al armarse y suena al entrar el precio en la zona (nota B o mejor).</div>`}
    ${histHtml ? `<div class="btc-card-sub">Últimos setups</div>${histHtml}` : ''}
  </div>`;
}

// ── Tarjeta: muros del order book ───────────────────────────────────────────
function btcBookCard(row) {
  const ob = BTC.book;
  if (!ob?.mid) return `<div class="btc-card"><div class="dt-sec-title">🧱 Muros del order book</div><div class="btc-card-empty">Cargando los libros de Bybit, Binance, OKX e Hyperliquid…</div></div>`;
  const all = [...(ob.askWalls || []), ...(ob.bidWalls || [])];
  const maxU = Math.max(...all.map(w => w.usd), 1);
  const line = (w, side) => {
    const d = (w.price - row.price) / row.price * 100;
    const age = w.first ? Math.max(1, Math.round((Date.now() - w.first) / 60_000)) : null;
    return `<div class="btc-wall ${side}${w.weak ? ' weak' : ''}">
      <span class="btc-wall-p">${fmtPrice(w.lo)}–${fmtPrice(w.hi).replace('$', '')}</span>
      <span class="btc-wall-bar"><i style="width:${Math.max(4, w.usd / maxU * 100).toFixed(0)}%"></i></span>
      <b>${fmtUSD(w.usd)}</b>
      <span class="btc-wall-d">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</span>
      <span class="btc-wall-src" title="Reparto por exchange · minutos que lleva puesto (desde que abriste la app) · fuerza: veces más gordo que un tramo típico">${w.weak ? 'zona densa · ' : ''}${btcBookSrcTxt(w.src)}${age ? ` · ${age} min` : ''} · ×${w.str.toFixed(1)}</span>
    </div>`;
  };
  const asks = [...(ob.askWalls || [])].sort((a, b) => b.price - a.price).map(w => line(w, 'ask')).join('')
    || '<div class="btc-card-empty">sin muros de venta destacados hasta +3%</div>';
  const bids = [...(ob.bidWalls || [])].sort((a, b) => b.price - a.price).map(w => line(w, 'bid')).join('')
    || '<div class="btc-card-empty">sin muros de compra destacados hasta −3%</div>';
  const imb = (ob.bidUSD - ob.askUSD) / Math.max(ob.bidUSD + ob.askUSD, 1);
  const ev = (ob.events || []).filter(e => Date.now() - e.ts < 60 * 60_000).slice(0, 3).map(e =>
    `<div class="btc-wall-ev">🫥 ${new Date(e.ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} · retiraron el muro de ${e.side === 'a' ? 'venta' : 'compra'} de ${fmtUSD(e.usd)} en ${fmtPrice(e.price)} con el precio cerca (llevaba ${Math.round(e.age / 60_000)} min) — típico de spoofing</div>`).join('');
  const books = (typeof BOOK_SRC !== 'undefined' ? BOOK_SRC : []).map(s => `${s.short}${ob.exch?.[s.key] ? '✓' : '✗'}`).join(' ');
  return `<div class="btc-card">
    <div class="dt-sec-title">🧱 Muros del order book · 5 libros · ±3%</div>
    ${asks}
    <div class="btc-wall-now">● ${fmtPrice(row.price)} · ±1%: compras ${fmtUSD(ob.bidUSD)} vs ventas ${fmtUSD(ob.askUSD)} <b style="color:${imb >= 0 ? '#2fe08a' : '#ff6666'}">${imb >= 0 ? '+' : ''}${(imb * 100).toFixed(0)}%</b></div>
    ${bids}
    ${ev}
    <div class="btc-card-note">Tramos de $${ob.B} sumando los libros de ${books}. Muro = tramo ≥2,5× más gordo que uno típico y ≥$2M. Los muros que aguantan minutos pesan más que los que aparecen y se van.</div>
  </div>`;
}

// ── Tarjeta: liquidaciones pendientes (modelo) + captura de CoinGlass ───────
function btcLiqCard(row) {
  const M = BTC.liqm;
  const shot = btcShotGet();
  let body;
  if (!M) body = '<div class="btc-card-empty">Calculando con el open interest de Bybit y Binance…</div>';
  else {
    const all = [...M.above, ...M.below];
    const maxU = Math.max(...all.map(c => c.usd), 1);
    const line = (c, side) => {
      const d = (c.level - row.price) / row.price * 100;
      return `<div class="btc-wall ${side}">
        <span class="btc-wall-p">${fmtPrice(c.level)}</span>
        <span class="btc-wall-bar liq"><i style="width:${Math.max(4, c.usd / maxU * 100).toFixed(0)}%"></i></span>
        <b>${fmtUSD(c.usd)}</b>
        <span class="btc-wall-d">${d >= 0 ? '+' : ''}${d.toFixed(2)}%</span>
        <span class="btc-wall-src">${side === 'ask' ? 'cortos' : 'largos'}</span>
      </div>`;
    };
    body = `${[...M.above].sort((a, b) => b.level - a.level).map(c => line(c, 'ask')).join('') || '<div class="btc-card-empty">sin clusters de cortos hasta +6%</div>'}
      <div class="btc-wall-now">● ${fmtPrice(row.price)} · en ±3%: ${fmtUSD(M.shortUSD3)} de cortos arriba / ${fmtUSD(M.longUSD3)} de largos abajo</div>
      ${[...M.below].sort((a, b) => b.level - a.level).map(c => line(c, 'bid')).join('') || '<div class="btc-card-empty">sin clusters de largos hasta −6%</div>'}`;
  }
  const shotHtml = shot ? `<div class="btc-card-sub">📸 Captura de CoinGlass · hace ${Math.round((Date.now() - shot.ts) / 60_000)} min · ${_btcEsc(shot.type)} <a href="#" onclick="btcShotClear();return false" class="btc-link">quitar</a></div>
      <div class="btc-shot-lvls">${shot.levels.map(l => `<span style="opacity:${(0.45 + 0.55 * (l.intensity || 0.5)).toFixed(2)}">${fmtPrice(l.price)}</span>`).join(' · ')}</div>
      ${shot.notes ? `<div class="btc-card-note">${_btcEsc(shot.notes)}</div>` : ''}`
    : `<div class="btc-card-note">📸 ¿Quieres cruzarlo con el de CoinGlass? Pega aquí (Ctrl+V) o arrastra una captura de su Liquidation Heatmap: Claude lee los niveles y se dibujan en rosa.</div>`;
  return `<div class="btc-card">
    <div class="dt-sec-title">🔥 Liquidaciones pendientes · modelo propio</div>
    ${body}
    <div class="btc-card-note">Estimado con el OI de Bybit${M?.srcs?.binance ? ' + Binance' : ''} cada 15m y apalancamientos 10/25/50/100x; un nivel se borra al tocarlo. El heatmap de CoinGlass es también un modelo: fíjate en dónde se amontona, no en la cifra exacta.</div>
    ${shotHtml}
  </div>`;
}

// ── 📸 Captura de CoinGlass → niveles (Claude lee la imagen en el server) ───
const BTC_SHOT_KEY = 'scalp_btc_cgshot';
const BTC_SHOT_TTL = 12 * 3600_000;
let _btcShotMsg = '';
let _btcShotBusy = false;
let _btcShotInput = null;
let _btcShotMsgTimer = null;

function btcShotGet() {
  try {
    const s = JSON.parse(localStorage.getItem(BTC_SHOT_KEY) || 'null');
    return s && Date.now() - s.ts < BTC_SHOT_TTL && Array.isArray(s.levels) ? s : null;
  } catch (_) { return null; }
}
function btcShotLevels() {
  const s = btcShotGet();
  return s ? s.levels.map(l => ({ price: l.price, intensity: l.intensity, label: `${l.side === 'above' ? 'arriba' : 'abajo'} · intensidad ${Math.round((l.intensity || 0) * 100)}%` })) : [];
}
function btcShotClear() {
  try { localStorage.removeItem(BTC_SHOT_KEY); } catch (_) { /* nada */ }
  if (activeTab === 'btc') renderBTC();
}
function btcShotPick() {
  if (!_btcShotInput) {
    _btcShotInput = document.createElement('input');
    _btcShotInput.type = 'file'; _btcShotInput.accept = 'image/*'; _btcShotInput.style.display = 'none';
    _btcShotInput.onchange = () => { const f = _btcShotInput.files?.[0]; if (f) btcShotSend(f); _btcShotInput.value = ''; };
    document.body.appendChild(_btcShotInput);
  }
  _btcShotInput.click();
}
document.addEventListener('paste', e => {
  if (typeof activeTab === 'undefined' || activeTab !== 'btc') return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  btcShotSend(item.getAsFile());
});
document.addEventListener('dragover', e => {
  if (typeof activeTab !== 'undefined' && activeTab === 'btc' && [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (typeof activeTab === 'undefined' || activeTab !== 'btc') return;
  const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  btcShotSend(f);
});

// Reduce la imagen a ≤1568 px por lado (lo que Claude usa de todas formas) en JPEG
async function _btcShotEncode(file) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  const url = cv.toDataURL('image/jpeg', 0.9);
  return { data: url.slice(url.indexOf(',') + 1), mediaType: 'image/jpeg' };
}

function _btcShotSetMsg(msg, ttl) {
  _btcShotMsg = msg;
  clearTimeout(_btcShotMsgTimer);
  if (ttl) _btcShotMsgTimer = setTimeout(() => { _btcShotMsg = ''; if (activeTab === 'btc') renderBTC(); }, ttl);
  if (activeTab === 'btc') renderBTC();
}

async function btcShotSend(file) {
  if (_btcShotBusy || !file) return;
  _btcShotBusy = true;
  _btcShotSetMsg('📸 Leyendo la captura de CoinGlass con Claude… (puede tardar 10–40 s)');
  try {
    const { data, mediaType } = await _btcShotEncode(file);
    const row = allRows.find(r => r.symbol === 'BTC');
    const price = row?.price || null;
    const r = await fetch('/api/vision/cg', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: data, mediaType, price }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    if (!j.is_liquidity_chart) throw new Error('no parece un heatmap o mapa de liquidaciones' + (j.notes ? ` (${j.notes})` : ''));
    const levels = (j.levels || [])
      .filter(l => Number.isFinite(+l.price) && +l.price > 0 && (!price || Math.abs(+l.price - price) / price < 0.2))
      .map(l => ({ price: +l.price, intensity: Math.max(0, Math.min(1, +l.intensity || 0)), side: l.side }))
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, 10);
    if (!levels.length) throw new Error('no se encontraron niveles legibles en la captura');
    let warn = '';
    if (price && j.current_price > 0 && Math.abs(j.current_price - price) / price > 0.015) {
      warn = ` ⚠ La captura marca el precio en ${fmtPrice(j.current_price)} y ahora está en ${fmtPrice(price)}: ¿es antigua o de otra moneda?`;
    }
    const shot = { ts: Date.now(), type: String(j.chart_type || 'CoinGlass').slice(0, 60), levels, notes: String(j.notes || '').slice(0, 300) };
    try { localStorage.setItem(BTC_SHOT_KEY, JSON.stringify(shot)); } catch (_) { /* sin espacio: queda solo este rato */ }
    _btcShotSetMsg(`📸 Captura leída: ${levels.length} niveles dibujados en rosa durante 12 h.${_btcEsc(warn)}`, 60_000);
  } catch (err) {
    _btcShotSetMsg(`📸 No se pudo leer la captura: ${_btcEsc(err.message)}`, 60_000);
  } finally {
    _btcShotBusy = false;
  }
}

// ── Hook por ciclo (lo llama load() en main.js) ─────────────────────────────
// btcFetchOB/btcFetchCG proxean Binance+OKX+CoinGlass A TRAVÉS del server
// (/api/exch/depth, /api/cg/*) — a diferencia del resto del screener, que va
// directo navegador→Bybit, ESTO SÍ cuenta contra el ancho de banda de Render.
// Con la pestaña en segundo plano no hay quien mire el sesgo de BTC: pausar
// aquí evita re-descargar ~35-40KB de order book cada 30s sin motivo (era el
// mismo problema que ya tuvimos con el bot viejo, ahora en esta función).
function btcOnCycle() {
  if (document.hidden) return;
  const now = Date.now();
  // Order book de 5 libros (≈130 KB por ronda, directo navegador→exchanges, no
  // pasa por Render): cada 30 s mirando la pestaña ₿, cada 90 s si no — los
  // muros siguen votando en el sesgo y el historial del mapa de calor se graba.
  if (now - (BTC.book?.ts || 0) > (activeTab === 'btc' ? 30_000 : 90_000)) btcBookFetch();
  if (now - (LIQM.ts      || 0) > 5 * 60_000)  btcLiqFetch();  // OI + taker → mapa de liquidaciones
  if (now - (BTC.htf?.ts  || 0) > 15 * 60_000) btcFetchHTF();  // contexto 4h + PDH/PDL + PWH/PWL
  if (now - (BTC.ls?.ts   || 0) > 60_000)      btcFetchLS();
  if (now - (BTC.mp?.ts   || 0) > 15 * 60_000) btcFetchOptions();
  if (now - (BTC.spot?.ts || 0) > 30_000)      btcFetchSpot();
  // CoinGlass vía server: si el plan no da NADA (todo "Upgrade plan"), se
  // reintenta cada 6 h en vez de cada 5 min — no tiene sentido gastar Render.
  if (now - (BTC.cg?.ts   || 0) > (BTC.cg?.allFail ? 6 * 3600_000 : 5 * 60_000)) btcFetchCG();
  if (now - (BTC.free?.ts || 0) > 60_000)      btcFetchFree(); // respaldo gratuito: top traders, premium, spot/perp
  if (now - (BTC.k15x?.ts || 0) > 5 * 60_000)  btcFetchK15x(); // velas extendidas (~10 días) para el zoom
  btcAccumLiqs(); // acumula liquidaciones de BTC (WS Bybit) por vela 15m — banda del gráfico
  btcComputeFactors();
  btcCheckFibZone(); // 🟡 alerta al entrar a la zona dorada del Fibonacci (50%–61.8%)
  btcSnapshotSessions();
  if (activeTab === 'btc') renderBTC();
}
