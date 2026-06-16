'use strict';
/**
 * bot/index.js
 * Loop principal del bot de PAPER TRADING (multi-estrategia, LXR) sobre Bybit.
 *
 * Flujo por ciclo:
 *   1. Referencia BTC -> régimen global (para guarda de correlación).
 *   2. Por símbolo: gestiona posición abierta (SL/TP/trailing/timeout).
 *   3. Calcula régimen y evalúa SOLO las estrategias permitidas por el régimen.
 *   4. Aplica circuit breaker (pérdida diaria / racha) y guarda de correlación.
 *   5. Abre la mejor señal en paper y registra todo.
 *
 * Uso:
 *   npm i ws
 *   node bot/index.js        # standalone
 * o montado en server.js:    require('./bot').startBot()
 *
 * Exporta { startBot, getState }. Órdenes SIEMPRE simuladas.
 */
require('dotenv').config();
const C = require('./config');
const bybit = require('./bybit');
const ind = require('./indicators');
const strategies = require('./strategies');
const { PaperBroker } = require('./paperBroker');
const { CircuitBreaker, correlationGuard, suggestSize } = require('./risk');
const { EdgeState } = require('./edge');

const state = {
  broker: null, stream: null, breaker: null, edge: null,
  lastSignals: [], regimes: {}, btcRegime: null, heatmaps: {},
  started: false,
};

async function cycle(broker, stream, breaker, edge) {
  const nowMs = Date.now();
  const signals = [];

  // referencia BTC para régimen global y fuerza relativa (una sola llamada)
  let btcCloses = [];
  let btcKlines = null;
  try {
    const kb = await bybit.klines(C.REGIME_REF);
    btcKlines = kb;
    btcCloses = kb.map(x => x.close);
    if (kb.length > C.ATR_PERIOD + 5) {
      state.btcRegime = ind.regime(kb.map(x => x.high), kb.map(x => x.low), btcCloses);
    }
  } catch (_) { /* sin referencia BTC este ciclo */ }

  // ── Semáforo de mercado (edge v2): rojo = no abrir; amarillo = mitad de riesgo
  let guard = { risk: 0, level: 'v', scale: 1, why: [] };
  if (C.EDGE_ENABLED && edge) {
    let liq5m = 0;
    const liqCut = nowMs - 300_000;
    for (const s of C.SYMBOLS) {
      for (const l of stream.getLiqs(s)) if (l.ts >= liqCut) liq5m += l.notional;
    }
    guard = edge.riskLight(btcKlines, liq5m);
  }

  for (const symbol of C.SYMBOLS) {
    try {
      const klines = await bybit.klines(symbol);
      if (!klines.length) continue;
      const price = klines[klines.length - 1].close;

      // Evaluación INTRAVELA de SL/TP: máx/mín de los trades del WS desde la
      // última revisión (no solo el close del ciclo). Si el WS no cubre el
      // intervalo, cae con elegancia a hi=lo=price (comportamiento anterior).
      const openPos = broker.positions.get(symbol);
      let hi = price, lo = price;
      if (openPos) {
        const checkTs = Date.now();
        const since = openPos.lastCheckMs || openPos.openedMs;
        for (const tr of stream.getTrades(symbol)) {
          if (tr.ts >= since) {
            if (tr.price > hi) hi = tr.price;
            if (tr.price < lo) lo = tr.price;
          }
        }
        openPos.lastCheckMs = checkTs;
      }
      broker.update(symbol, price, hi, lo);

      // régimen + heatmap siempre (para el panel), aunque no operemos
      const highs = klines.map(k => k.high), lows = klines.map(k => k.low), closes = klines.map(k => k.close);
      state.regimes[symbol] = ind.regime(highs, lows, closes);
      state.heatmaps[symbol] = ind.liquidationHeatmap(klines, price);

      // contexto para el semáforo (chop direccional del universo)
      if (C.EDGE_ENABLED && edge && closes.length > 61) {
        edge.record(symbol, (price - closes[closes.length - 61]) / closes[closes.length - 61] * 100);
      }

      if (!broker.canOpen(symbol)) continue;
      if (stream.coverageSec() < C.WS_WARMUP_SEC) continue; // warmup: buffers WS aún fríos
      if (!breaker.canTrade(broker.equity)) continue; // circuit breaker
      if (guard.scale === 0) { if (edge) edge.skipped('guard'); continue; } // semáforo en rojo

      const [oiSeries, fundingHist] = await Promise.all([
        bybit.openInterest(symbol),
        bybit.fundingHistory(symbol),
      ]);
      const currentFunding = fundingHist.length ? fundingHist[fundingHist.length - 1] : 0;
      if (C.EDGE_ENABLED && edge) edge.recordFunding(symbol, currentFunding);

      const ctx = {
        symbol, klines, oiSeries, fundingHist, currentFunding,   // symbol completo (BTCUSDT) para casar con el broker
        trades: stream.getTrades(symbol), liqs: stream.getLiqs(symbol),
        btcCloses, nowMs,
        // baseline efectivo del z-score de liqs = cobertura real del WS
        liqBaselineSec: Math.max(1, Math.floor(stream.coverageSec())),
      };
      const { best, regime } = strategies.evaluateAll(ctx);
      if (regime) state.regimes[symbol] = regime;
      if (!best) continue;

      // guarda de correlación
      const corrGuard = correlationGuard([...broker.positions.values()], best, state.btcRegime);
      if (!corrGuard.ok) { continue; }

      // ── Edge v2: estrategias con expectancy negativa quedan desactivadas,
      // y cada operación debe pasar el filtro de salud (calidad mínima).
      if (C.EDGE_ENABLED && edge) {
        const sStats = edge.strategyStats(broker.closed);
        if (sStats.disabled.includes(best.strategy)) {
          edge.skipped('disabled');
          console.log(`[EDGE] ${symbol}: señal de '${best.strategy}' ignorada — estrategia desactivada por expectancy negativa.`);
          continue;
        }
        const q = await edge.qualityGate(ctx, best);
        if (!q.ok) {
          edge.skipped('quality');
          console.log(`[EDGE] ${symbol}: señal de '${best.strategy}' rechazada por salud ${q.score}% (${q.bad.join(', ')}).`);
          continue;
        }
        best.quality = q.score;
      }

      signals.push(best);
      const pos = broker.open(best, guard.scale);
      if (pos) {
        console.log(`[ABIERTA][${best.strategy}] ${best.side.toUpperCase()} ${symbol} @ ${pos.entry.toFixed(6)} ` +
          `| SL ${pos.stop.toFixed(6)} TP ${pos.takeProfit.toFixed(6)} | score ${best.score}` +
          (best.quality != null ? ` | salud ${best.quality}%` : '') +
          (guard.scale !== 1 ? ` | riesgo ×${guard.scale} (semáforo)` : '') +
          ` | régimen ${regime.regime} | ${best.reason}`);
      }
    } catch (e) {
      console.warn(`[warn] ${symbol}: ${e.message}`);
    }
  }

  // alimentar el circuit breaker con los trades cerrados desde el último ciclo
  while (broker._pendingClosed && broker._pendingClosed.length) {
    breaker.onClosedTrade(broker._pendingClosed.shift().pnl);
  }
  state.lastSignals = signals.length ? signals : state.lastSignals;
}

async function startBot() {
  if (state.started) return state;
  state.started = true;
  const broker = new PaperBroker();
  broker._pendingClosed = [];
  // hook: cada cierre empuja a la cola del circuit breaker
  const origClose = broker._close.bind(broker);
  broker._close = (pos, price, reason) => { const rec = origClose(pos, price, reason); if (rec) broker._pendingClosed.push(rec); return rec; };

  const stream = new bybit.Stream(C.SYMBOLS);
  const breaker = new CircuitBreaker();
  const edge = C.EDGE_ENABLED ? new EdgeState() : null;
  state.broker = broker; state.stream = stream; state.breaker = breaker; state.edge = edge;

  // Rehidratar desde Turso: equity/historial + estado del día del circuit breaker.
  try {
    if (await broker.hydrate()) {
      const todayStartMs = Date.parse(new Date().toISOString().slice(0, 10)); // medianoche UTC (igual que _today())
      const todays = broker.closed.filter(t => t.closed_at >= todayStartMs);
      breaker.hydrate(broker.equity, todays);
      console.log(`Estado rehidratado desde Turso: ${broker.closed.length} trades, equity=${broker.equity.toFixed(2)}, hoy=${todays.length} trades.`);
    }
  } catch (e) { console.warn('No se pudo rehidratar desde Turso:', e.message); }

  // Grabación de order flow para backtests (LXR_RECORD=1): CVD por buckets +
  // liquidaciones raw en Turso. Sin esto, esos datos se pierden al cerrar.
  if (process.env.LXR_RECORD === '1') {
    try {
      const { FlowRecorder } = require('./recorder');
      state.recorder = new FlowRecorder();
      state.recorder.attach(stream);
    } catch (e) { console.warn('Recorder no disponible:', e.message); }
  }

  try { stream.start(); }
  catch (e) { console.error(e.message); console.error('LXR/estrategias necesitan liquidaciones y CVD en vivo (WS).'); }

  console.log(`Bot multi-estrategia iniciado | símbolos: ${C.SYMBOLS.join(', ')}`);
  console.log(`Calentando buffers de order flow (warmup ${C.WS_WARMUP_SEC}s antes de abrir posiciones)...`);
  await new Promise(r => setTimeout(r, 10000));

  const loop = async () => {
    const t0 = Date.now();
    try { await cycle(broker, stream, breaker, edge); } catch (e) { console.warn('ciclo:', e.message); }
    const s = broker.stats(); const b = breaker.state();
    const g = edge ? edge.lastGuard : null;
    console.log(`[WS ${stream.connected ? 'ON' : 'OFF'}]${g ? ` [${g.level === 'v' ? '🟢' : g.level === 'a' ? '🟡' : '🔴'} ${g.risk}]` : ''} equity=${s.equity} abiertas=${s.openPositions} cerradas=${s.trades || 0}` +
      (s.trades ? ` | win%=${s.winRate} avgR=${s.avgR} PF=${s.profitFactor} ret%=${s.returnPct}` : '') +
      (b.halted ? ` | ⛔ PAUSADO: ${b.reason}` : ` | díaPnL%=${b.dayPnlPct}`));
    const elapsed = (Date.now() - t0) / 1000;
    setTimeout(loop, Math.max(1000, (C.POLL_SECONDS - elapsed) * 1000));
  };
  loop();
  return state;
}

/** Levanta manualmente la pausa del circuit breaker (botón "Reanudar ahora" del panel). */
function resetBreaker() {
  if (!state.breaker) return { ok: false, error: 'bot no iniciado' };
  state.breaker.dayPnl = 0;
  state.breaker.lossStreak = 0;
  state.breaker.halted = false;
  state.breaker.haltReason = null;
  return { ok: true, circuitBreaker: state.breaker.state() };
}

function getState() {
  const b = state.broker;
  return {
    started: state.started,
    wsConnected: state.stream ? state.stream.connected : false,
    wsCoverageSec: state.stream ? Math.floor(state.stream.coverageSec()) : 0,
    warmupSec: C.WS_WARMUP_SEC,
    stats: b ? b.stats() : null,
    circuitBreaker: state.breaker ? state.breaker.state() : null,
    openPositions: b ? [...b.positions.values()] : [],
    recentTrades: b ? b.closed.slice(-10).reverse() : [],
    lastSignals: state.lastSignals,
    btcRegime: state.btcRegime,
    regimes: state.regimes,
    heatmaps: state.heatmaps,
    expectancy: b ? ind.expectancy(b.closed) : null,
    recorder: state.recorder ? state.recorder.stats() : null,
    edge: state.edge ? {
      ...state.edge.state(),
      strategies: b ? state.edge.strategyStats(b.closed) : null,
    } : null,
  };
}

module.exports = { startBot, getState, suggestSize, resetBreaker };

if (require.main === module) {
  startBot();
  process.on('SIGINT', () => { console.log('\nCerrando bot.'); state.stream && state.stream.stop(); process.exit(0); });
}
