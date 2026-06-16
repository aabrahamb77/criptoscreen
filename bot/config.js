'use strict';
/** Configuración del bot de paper trading. Sobreescribible por variables de entorno. */
module.exports = {
  REST: 'https://api.bybit.com',
  WS: 'wss://stream.bybit.com/v5/public/linear',
  CATEGORY: 'linear',

  // Universo. Por defecto los más operados; ajusta a tu gusto.
  SYMBOLS: (process.env.LXR_SYMBOLS ||
    'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,SUIUSDT,WLDUSDT,ENAUSDT,HYPEUSDT,AVAXUSDT'
  ).split(',').map(s => s.trim()).filter(Boolean),

  KLINE_INTERVAL: '1',
  KLINE_LIMIT: 200,
  OI_INTERVAL: '5min',
  OI_LIMIT: 50,
  FUNDING_LIMIT: 60,

  POLL_SECONDS: 15,
  ATR_PERIOD: 14,

  CVD_WINDOW_SEC: 60,
  CVD_TREND_SEC: 300,
  LIQ_WINDOW_SEC: 90,
  LIQ_BASELINE_SEC: 3600,

  // Umbrales LXR
  LIQ_Z_THRESHOLD: 2.0,
  LIQ_DOMINANCE: 0.70,
  EXT_ATR_MULT: 1.5,
  OI_DROP_PCT: 0.30,
  FUNDING_Z_CONFLUENCE: 1.5,
  MIN_SIGNAL_SCORE: 60,

  // Riesgo / paper broker
  START_EQUITY: Number(process.env.LXR_EQUITY || 10000),
  RISK_PCT: 0.005,
  MAX_CONCURRENT: 3,
  STOP_ATR_MULT: 1.2,
  TP_R_MULTIPLE: 1.5,
  TRAIL_ACTIVATE_R: 1.0,
  TRAIL_ATR_MULT: 1.0,
  MAX_HOLD_SEC: 1800,
  TAKER_FEE: 0.00055,
  SLIPPAGE_BPS: 2.0,

  // Régimen / fuerza relativa
  REGIME_REF: 'BTCUSDT',      // símbolo de referencia para fuerza relativa
  RS_LOOKBACK: 60,            // velas de 1m para RS vs BTC

  // Circuit breaker / correlación
  MAX_DAILY_LOSS_PCT: 0.03,   // pausa el día si pierde 3% del equity
  MAX_LOSS_STREAK: 4,         // pausa tras 4 pérdidas seguidas
  MAX_SAME_SIDE: 3,           // máx. posiciones simultáneas en el mismo lado

  // Warmup del WebSocket: no abrir posiciones hasta tener esta cobertura
  // mínima de datos en vivo (CVD/liqs) tras conectar o RECONECTAR. Además el
  // baseline del z-score de liquidaciones se acota a la cobertura real.
  WS_WARMUP_SEC: Number(process.env.LXR_WARMUP_SEC || 120),

  // ── Capa de edge (bot v2) ── LXR_EDGE=0 la desactiva por completo.
  EDGE_ENABLED: process.env.LXR_EDGE !== '0',
  EDGE_MIN_QUALITY_PCT: Number(process.env.EDGE_MIN_QUALITY || 0.6), // salud mínima por operación (0-1)
  EDGE_DISABLE_MIN_TRADES: 15,    // trades mínimos antes de poder desactivar una estrategia
  EDGE_DISABLE_EXPECTANCY: -0.05, // expectancy R por debajo de esto → estrategia desactivada
};
