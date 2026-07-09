/* public/core.js
 * Cliente Bybit (REST), snapshots de OI en memoria, loadData y estado global.
 * Se carga DESPUÉS de lxr.js y radar.js, y ANTES de screener.js/map.js/lab.js/track.js/main.js.
 * Todo vive en scope global (scripts clásicos compartidos).
 */

// ── Cliente Bybit API (browser llama directamente, evita bloqueos cloud) ───
const BYBIT_BASE = 'https://api.bybit.com';

async function bybitGet(endpoint) {
  const res = await fetch(BYBIT_BASE + endpoint, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const pctCalc = (curr, prev) =>
  prev && prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : null;
const sumArr = arr => arr.reduce((a, b) => a + b, 0);

const oiSnaps  = new Map();
const oiPrevUSD = new Map(); // para detectar caídas de OI → liquidaciones

async function pollSnapshots() {
  try {
    const res = await bybitGet('/v5/market/tickers?category=linear');
    const now = Date.now();
    for (const t of res.result.list) {
      if (!t.symbol.endsWith('USDT')) continue;
      const oiUSD = parseFloat(t.openInterestValue);
      const sym = t.symbol;

      // Guardar snapshot para cálculos de OI%
      if (!oiSnaps.has(sym)) oiSnaps.set(sym, []);
      const arr = oiSnaps.get(sym);
      arr.unshift({ ts: now, oiUSD });
      if (arr.length > 1500) arr.length = 1500;

      // Detectar caída de OI >= 0.4% → probable liquidación
      if (oiPrevUSD.has(sym)) {
        const prev = oiPrevUSD.get(sym);
        const drop = prev - oiUSD;
        const dropPct = prev > 0 ? drop / prev * 100 : 0;
        if (dropPct >= 0.4 && drop > 1000) {
          const price = parseFloat(t.lastPrice);
          const pChg  = parseFloat(t.price24hPcnt ?? 0);
          // Si precio bajó → longs liquidados; si subió → shorts liquidados
          liqEvents.unshift({
            symbol: sym.replace('USDT',''),
            isLong: pChg < 0,
            usdVal: drop,
            ts: now,
            fromOI: true
          });
          if (liqEvents.length > 300) liqEvents.length = 300;
          updateLiqBar();
        }
      }
      oiPrevUSD.set(sym, oiUSD);
    }
  } catch(e) { console.error('snapshot poll error:', e.message); }
}

function snapAt(symbol, msAgo) {
  const arr = oiSnaps.get(symbol);
  if (!arr?.length) return null;
  const target = Date.now() - msAgo;
  const best = arr.reduce((b, s) =>
    Math.abs(s.ts - target) < Math.abs(b.ts - target) ? s : b);
  if (Math.abs(best.ts - target) > 90_000) return null;
  return best.oiUSD;
}

// OI de hace 24h por símbolo, cacheado 10 min. Necesario porque el endpoint
// de 5min está capado a 200 puntos (~16.6h): el índice [288] nunca existía y
// oi24h salía null siempre → el mapa en 1d quedaba vacío y la alineación
// 15m·1h·4h·1d no se cumplía nunca.
const _oi24Cache = new Map(); // symbol → { ts, val } (val = OI USD hace 24h o null)

async function oi24hAgoUSD(symbol, currentPrice) {
  const hit = _oi24Cache.get(symbol);
  if (hit && Date.now() - hit.ts < 10 * 60_000) return hit.val;
  let val = null;
  try {
    const r = await bybitGet(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=25`);
    const list = r.result?.list; // orden: más nuevo primero
    if (list?.length >= 20) val = parseFloat(list[list.length - 1].openInterest) * currentPrice;
  } catch (_) { /* siguiente ciclo lo reintenta */ }
  _oi24Cache.set(symbol, { ts: Date.now(), val });
  return val;
}

async function fetchSymbolData(symbol, currentOIusd, currentPrice) {
  const [oiRes, k1hRes, k5mRes, oi24Ago] = await Promise.all([
    bybitGet(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=200`),
    bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=50`),
    bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=288`),
    oi24hAgoUSD(symbol, currentPrice),
  ]);
  const oiList = oiRes.result?.list;
  const k1h = k1hRes.result?.list;
  const k5m = k5mRes.result?.list;
  if (!oiList?.length || !k1h?.length || !k5m?.length) return null;

  const oi_usd = oiList.map(x => parseFloat(x.openInterest) * currentPrice);
  const oi5m  = pctCalc(currentOIusd, snapAt(symbol, 5*60_000)       ?? oi_usd[1]);
  const oi15m = pctCalc(currentOIusd, snapAt(symbol, 15*60_000)      ?? oi_usd[3]);
  const oi1h  = pctCalc(currentOIusd, snapAt(symbol, 60*60_000)      ?? oi_usd[12]);
  const oi4h  = pctCalc(currentOIusd, snapAt(symbol, 4*60*60_000)    ?? oi_usd[48]);
  const oi24h = pctCalc(currentOIusd, snapAt(symbol, 24*60*60_000)   ?? oi24Ago);

  const vol1h = k1h.map(k => parseFloat(k[6]));
  const cls1h = k1h.map(k => parseFloat(k[4]));
  const vol1hPct  = k1h.length > 2  ? pctCalc(vol1h[1], vol1h[2]) : null;
  const vol12hPct = k1h.length > 24 ? pctCalc(sumArr(vol1h.slice(1,13)), sumArr(vol1h.slice(13,25))) : null;
  const vol24hPct = k1h.length > 48 ? pctCalc(sumArr(vol1h.slice(1,25)), sumArr(vol1h.slice(25,49))) : null;
  const cls5m = k5m.map(k => parseFloat(k[4]));
  const price5mPct  = cls5m.length > 2 ? pctCalc(cls5m[1], cls5m[2]) : null;
  const price15mPct = cls5m.length > 4 ? pctCalc(cls5m[1], cls5m[4]) : null;
  const spark = cls5m.slice(0, 25).reverse(); // últimas ~2h en velas 5m (viejo→nuevo) — sparkline + correlación vs BTC
  const price1hPct  = cls1h.length > 1 ? pctCalc(cls1h[0], cls1h[1]) : null;
  const price4hPct  = cls1h.length > 4 ? pctCalc(cls1h[0], cls1h[4]) : null;

  const symNoUSDT = symbol.replace('USDT', '');
  const trades = LXR.CVD.get(symNoUSDT);
  // CVD en USD (size × price por trade) — antes sumaba unidades de moneda pero
  // se mostraba como USD. null (no $0) cuando aún no hay trades en el buffer.
  const _cvdUSD = since => {
    let v = 0;
    for (const t of trades) { if (t.ts >= since) v += (t.side === 'Buy' ? 1 : -1) * t.size * (t.price || 0); }
    return v;
  };
  const cvd1m = trades.length ? _cvdUSD(Date.now() - 60_000) : null;
  const cvd5m = trades.length ? _cvdUSD(Date.now() - 300_000) : null;

  // ATR de velas 1h (viejo→nuevo) para stops sugeridos y normalización σ
  const hi1hRev = k1h.map(k => parseFloat(k[2])).reverse();
  const lo1hRev = k1h.map(k => parseFloat(k[3])).reverse();
  const cl1hRev = cls1h.slice().reverse();
  const atr1h   = LXR.metrics.atr(hi1hRev, lo1hRev, cl1hRev, 14);

  // Velas 15m (agregadas de las 5m, viejo→nuevo, ~24h): detector de patrones
  // W/M + panel de detalle. Se agrupan por bucket de 15 min alineado al reloj.
  const k15 = { t: [], o: [], h: [], l: [], c: [], v: [] };
  {
    const t5 = k5m.map(k => +k[0]).reverse();
    const o5 = k5m.map(k => parseFloat(k[1])).reverse();
    const h5 = k5m.map(k => parseFloat(k[2])).reverse();
    const l5 = k5m.map(k => parseFloat(k[3])).reverse();
    const c5 = cls5m.slice().reverse();
    const v5 = k5m.map(k => parseFloat(k[5])).reverse();
    let bucket = -1;
    for (let i = 0; i < t5.length; i++) {
      const b = Math.floor(t5[i] / 900_000); // bucket de 15 min
      if (b !== bucket) {
        bucket = b;
        k15.t.push(b * 900_000); k15.o.push(o5[i]); k15.h.push(h5[i]);
        k15.l.push(l5[i]); k15.c.push(c5[i]); k15.v.push(v5[i]);
      } else {
        const j = k15.c.length - 1;
        k15.h[j] = Math.max(k15.h[j], h5[i]);
        k15.l[j] = Math.min(k15.l[j], l5[i]);
        k15.c[j] = c5[i];
        k15.v[j] += v5[i];
      }
    }
  }

  return { oi5m, oi15m, oi1h, oi4h, oi24h, vol1hPct, vol12hPct, vol24hPct,
           price5mPct, price15mPct, price1hPct, price4hPct, vol1hUSD: vol1h[1] ?? 0,
           cvd1m, cvd5m, atr1h, spark, k15 };
}

async function loadData() {
  const tickRes = await bybitGet('/v5/market/tickers?category=linear');
  const tickers = tickRes.result.list
    .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.turnover24h) > 500_000)
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .slice(0, 100);

  const rows = [];
  for (let i = 0; i < tickers.length; i += 8) {
    const batch = tickers.slice(i, i + 8);
    const settled = await Promise.allSettled(batch.map(async t => {
      const d = await fetchSymbolData(t.symbol, parseFloat(t.openInterestValue), parseFloat(t.lastPrice));
      if (!d) return null;
      return {
        symbol: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        price24hPct: parseFloat(t.price24hPcnt) * 100,
        fundingRate: parseFloat(t.fundingRate) * 100,
        oiUSD: parseFloat(t.openInterestValue),
        turnover24h: parseFloat(t.turnover24h),
        ...d,
      };
    }));
    for (const s of settled) if (s.status === 'fulfilled' && s.value) rows.push(s.value);
  }
  rows.sort((a, b) => (b.oi5m ?? -Infinity) - (a.oi5m ?? -Infinity));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { ts: Date.now(), symbols: rows };
}

pollSnapshots();
setInterval(pollSnapshots, 60_000);

// ── Estadística: intervalo de Wilson (95%) para win rates ──────────────────
// Un 75% de acierto con n=8 no significa nada; el intervalo de Wilson lo hace
// explícito: devuelve el margen ± en puntos porcentuales. Con n pequeño el
// intervalo es enorme — esa es la señal de que el dato aún no es fiable.
function wilsonCI(hits, n, z = 1.96) {
  if (!n || n <= 0) return null;
  const p = Math.max(0, Math.min(1, hits / n));
  const z2 = z * z;
  const denom  = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, (center - margin) * 100),
    hi: Math.min(100, (center + margin) * 100),
    pm: margin * 100,
  };
}

// Margen ± (puntos) a partir de un winRate ya calculado (0-100) y su n.
function wrMargin(winRate, n) {
  const ci = wilsonCI(winRate / 100 * n, n);
  return ci ? Math.round(ci.pm) : null;
}

// n mínimo para tomarse un win rate en serio (por debajo se muestra apagado)
const WR_MIN_N = 10;

// Chip HTML compacto: "62% ±13" — apagado y con ⚠ si la muestra es chica.
function wrChip(winRate, n) {
  if (n == null || !n) return '—';
  const pm = wrMargin(winRate, n);
  const small = n < WR_MIN_N;
  const pmTxt = pm != null ? `<span style="font-weight:400;opacity:.6;font-size:0.9em">±${pm}</span>` : '';
  return small
    ? `<span style="opacity:.55" title="Muestra insuficiente (n=${n} < ${WR_MIN_N}): el intervalo de confianza es demasiado ancho para fiarse">${winRate}% ${pmTxt} ⚠</span>`
    : `${winRate}% ${pmTxt}`;
}

// ── Safe Storage Helper ───────────────────────────────────────────────────
function safeSetItem(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (e) {
    console.warn(`[Storage] Excedido el límite de localStorage al guardar ${key}:`, e.message);
  }
}

// ── State ──────────────────────────────────────────────────────────────────
let allRows = [];
let sortCol = 'oi5m';
let sortDir = -1;
let favorites = new Set(JSON.parse(localStorage.getItem('scalp_favs') || '[]'));
let countdownVal = 10;
let isLoading = false;
let activeTab = 'screener';
let bubbleHitTargets = [];
let badgeHitTargets  = [];
let chartZoom = { scale: 1, offsetX: 0, offsetY: 0 };
let chartScoredCache = null;
let labScoredCache   = null; // último array `scored` (cur/pct/reg/z) de renderLab — para heat score bajo demanda
let activeQuadrant   = null;
let hoveredSymbol    = null;
let hoverAnimFrame   = null;
let chartTf          = '1h';
let soundEnabled     = false;
let prevAligned      = new Set();
let bubbleSizeMetric = 'vol'; // 'vol' | 'oi' | 'funding'
let prevQuadrants    = new Map();

// ── Radar de confluencia + mejoras del mapa: estado y funciones en /radar.js ──

// ── Seguimiento de favoritos (historial de señales + resultado) ────────────
let trackHistory   = JSON.parse(localStorage.getItem('scalp_track') || '{}'); // symbol → [{ts,price,score,isLong,regime,...}]
let lastTrackLog   = new Map(); // symbol → ts del último snapshot guardado (throttle ~1/min)
const TRACK_MAX    = 1500;      // ~25h de historial a 1 snapshot/min
const TRACK_SCORE_MIN = 6;      // umbral de score para considerar "señal"
let trackRegimeFilter = 'ALL';  // 'ALL' | 'ALCISTA' | 'BAJISTA' | 'VOLÁTIL' | 'LATERAL'
let trackPanelExpanded = false; // tarjeta de seguimiento colapsada por defecto (lista puede ser larga)

// ── Radar automático "on fire" ─────────────────────────────────────────────
// symbol → { addedAt, expiresAt, side, heat }. Se auto-puebla con las monedas
// de mayor heat score en cada ciclo y expira sola si dejan de destacar.
let autoTracked = new Map(Object.entries(JSON.parse(localStorage.getItem('scalp_autotrack') || '{}')));
const AUTOTRACK_TOP_N   = 5;
const AUTOTRACK_TTL_MS  = 6 * 60 * 60_000; // 6h de seguimiento temporal
function saveAutoTracked() {
  safeSetItem('scalp_autotrack', JSON.stringify(Object.fromEntries(autoTracked)));
}

// ── Comparador de estrategias del Lab (Actual/Percentil/Régimen/Z-Score) ───
// Cada vez que un símbolo entra al Top-4 de una estrategia se registra como
// "señal" con su precio de entrada; 30min/1h después se evalúa si el precio
// se movió a favor, y así se mide qué estrategia acierta más en la práctica.
let stratSignals    = JSON.parse(localStorage.getItem('scalp_stratsig') || '[]');
let activeStratPick = new Map(); // 'estrategia|símbolo|lado' → true mientras siga en el Top
let activePanelPick = new Map(); // igual pero para detecciones de paneles (confluencia/salud/potencial)
const STRAT_SIG_MAX = 3000;
const STRAT_NAMES   = { cur: 'Actual', pct: 'Percentil', reg: 'Régimen', z: 'Z-Score',
  range: 'Ruptura rango', liq: 'Cascada liq.', sector: 'Rotación sectorial', whale: 'Ballenas',
  beta: 'Beta rezagada', alpha: 'Alpha propio',
  confluence: 'Confluencia', health: 'Saludable', promising: 'Prometedoras (heat)',
  patternWM: 'Patrón W/M', squeeze: 'Squeeze/Acum. (potencial)', outlier: 'Outlier real',
  momentum: 'Momentum confirmado (5%/10%)' };
let stratRegimeFilter = 'ALL'; // 'ALL' | 'ALCISTA' | 'BAJISTA' | 'VOLÁTIL' | 'LATERAL'
let quadrantHistory  = new Map(); // symbol → [{q,ts}] últimas 8 entradas
let filterFavOnly    = false;
let liqEvents        = []; // {symbol,isLong,usdVal,ts}
let liqLong5m = 0, liqShort5m = 0;
let prevScores       = new Map(); // symbol → {score, isLong} — ciclo anterior
let scoreSnap        = new Map(); // snapshot de prevScores al inicio de render (para flechas)
let scoreFirstSeen   = new Map(); // symbol → {level, ts}
let scoreFilter      = 0;
let liqSumCache      = new Map(); // symbol → {l,s} USD últimos 5m
