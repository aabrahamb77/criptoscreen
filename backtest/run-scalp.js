// Barrido de las familias de scalping.
// Uso: node backtest/run-scalp.js <familia> <intervalo> [top] [maker]
const E = require('./engine');
const SC = require('./scalp');

const COSTES = {
  // orden a mercado: taker de Bybit + deslizamiento realista en BTC
  taker: { comision: 0.00055, slippage: 0.0002 },
  // orden limite: maker de Bybit, deslizamiento casi nulo (pero no siempre entra)
  maker: { comision: 0.0002,  slippage: 0.00005 }
};

function combinaciones(rejilla) {
  const claves = Object.keys(rejilla);
  let out = [{}];
  for (const k of claves) {
    const sig = [];
    for (const base of out) for (const v of rejilla[k]) sig.push({ ...base, [k]: v });
    out = sig;
  }
  return out;
}

// Metricas de un subconjunto de operaciones (para partir dentro/fuera de muestra
// sin repetir el backtest completo).
function resumen(trades) {
  const n = trades.length;
  if (!n) return { ops: 0, pf: 0, pnl: 0, wr: 0 };
  const g = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const p = -trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return {
    ops: n, pnl: g - p, pf: p ? g / p : (g > 0 ? Infinity : 0),
    wr: trades.filter(t => t.pnl > 0).length / n * 100
  };
}

function anios(trades) {
  const m = {};
  for (const t of trades) {
    const a = new Date(t.tsOut).getUTCFullYear();
    m[a] = (m[a] || 0) + t.pnl;
  }
  return m;
}

function correr(familia, intervalo, top = 8, tipoCoste = 'taker', rejillaExtra = {}) {
  const d = E.cargar('BTCUSDT', intervalo);
  const c = SC.crearCacheScalp(d);
  const fn = SC.familias[familia];
  const cfg = { ...COSTES[tipoCoste], capital: 10000, riesgo: 1.0 };
  const rejilla = { ...SC.REJILLAS[familia], ...rejillaExtra };
  const combos = combinaciones(rejilla);
  const corte = Date.parse(intervalo === '5' ? '2025-01-01' : '2024-01-01');

  const res = [];
  for (const p of combos) {
    if (p.rapida !== undefined && p.rapida >= p.lenta) continue;
    const r = E.backtest(d, fn(d, c, p), cfg);
    if (r.ops < 60) continue;
    const is  = resumen(r.trades.filter(t => t.tsOut <  corte));
    const oos = resumen(r.trades.filter(t => t.tsOut >= corte));
    if (!is.ops || !oos.ops) continue;
    const porA = anios(r.trades);
    const vals = Object.values(porA);
    const positivos = vals.filter(v => v > 0).length / vals.length;
    const score = Math.min(Math.min(is.pf, oos.pf), 3) * 3 + positivos * 3 - r.maxDD / 20;
    res.push({ p, r, is, oos, porA, positivos, score });
  }
  res.sort((a, b) => b.score - a.score);
  return { d, combos: combos.length, evaluadas: res.length, res, cfg, corte };
}

const f = (n, w = 8) => ((n >= 0 ? '+' : '') + n.toFixed(1)).padStart(w);

function linea(x, i) {
  const { p, r, is, oos, porA } = x;
  const aa = Object.entries(porA).map(([a, v]) => `${a}:${v > 0 ? '+' : ''}${(v / 100).toFixed(0)}`).join(' ');
  const apto = is.pf > 1.1 && oos.pf > 1.1 && r.retorno > 0;
  return `#${String(i + 1).padStart(2)} ${apto ? '[APTO]' : '      '} ${JSON.stringify(p)}
     ret ${f(r.retorno, 10)}%  PF ${r.pf.toFixed(2)}  DD ${r.maxDD.toFixed(1)}%  ops ${r.ops}  WR ${r.winRate.toFixed(1)}%  ratio ${(r.mediaGan / r.mediaPer).toFixed(2)}
     IS  PF ${is.pf.toFixed(2)} (${is.ops})   OOS PF ${oos.pf.toFixed(2)} (${oos.ops})   L-PF ${r.largos.pf.toFixed(2)} S-PF ${r.cortos.pf.toFixed(2)}
     año ${aa}`;
}

if (require.main === module) {
  const familia = process.argv[2];
  const intervalo = process.argv[3] || '15';
  const top = +(process.argv[4] || 6);
  const coste = process.argv[5] || 'taker';
  const t0 = Date.now();
  const out = correr(familia, intervalo, top, coste);
  const aptas = out.res.filter(x => x.is.pf > 1.1 && x.oos.pf > 1.1 && x.r.retorno > 0).length;
  console.log(`\n══ ${familia} · BTCUSDT ${intervalo}m · coste ${coste} · ${out.combos} combos · ${out.evaluadas} con >=60 ops · ${aptas} APTAS · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  out.res.slice(0, top).forEach((x, i) => console.log(linea(x, i)));
  if (!out.res.length) console.log('  (ninguna combinacion genero suficientes operaciones)');
}

module.exports = { correr, linea, COSTES, combinaciones, resumen };
