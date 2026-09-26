// Barrido de parametros sobre las familias de estrategias.
// Uso: node backtest/run.js <familia> <intervalo> [top]
const E = require('./engine');
const S = require('./strategies');

const CFG = { comision: 0.00055, slippage: 0.0002, capital: 10000, riesgo: 1.0 };
const CORTE_OOS = Date.parse('2024-01-01T00:00:00Z');   // IS antes / OOS despues

// ── rejillas de parametros por familia ─────────────────────────────────────
const REJILLAS = {
  s1_donchian: {
    entrada:   [20, 30, 40, 55, 80, 120],
    tendLen:   [50, 100, 200, 300],
    atrLen:    [14],
    stopMult:  [1.5, 2, 2.5, 3],
    trailMult: [2, 3, 4, 5]
  },
  s2_emaCross: {
    rapida:    [9, 12, 20, 21],
    lenta:     [26, 50, 55, 100],
    tendLen:   [100, 200],
    adxLen:    [14],
    adxMin:    [0, 18, 22, 26],
    atrLen:    [14],
    stopMult:  [1.5, 2, 3],
    trailMult: [3, 4, 6]
  },
  s3_supertrend: {
    stLen:     [7, 10, 14, 20],
    stMult:    [2, 2.5, 3, 4],
    tendLen:   [50, 100, 200],
    atrLen:    [14],
    stopMult:  [2, 3, 4]
  },
  s4_reversion: {
    bbLen:     [20, 30, 50],
    bbMult:    [2, 2.5, 3],
    rsiLen:    [14],
    rsiBajo:   [25, 30, 35],
    rsiAlto:   [65, 70, 75],
    adxLen:    [14],
    adxMax:    [20, 25, 30],
    atrLen:    [14],
    stopMult:  [2, 3, 4]
  },
  s5_squeeze: {
    bbLen:     [20],
    bbMult:    [2],
    kcLen:     [20],
    kcMult:    [1.5, 2],
    barrasSqz: [3, 6, 10],
    rupt:      [10, 20, 30],
    tendLen:   [100, 200],
    stopMult:  [2, 3],
    trailMult: [3, 4, 6]
  },
  s6_momentum: {
    lookback:  [20, 40, 60, 90],
    tendLen:   [100, 200],
    pendiente: [10, 20, 40],
    pendMin:   [0, 0.002, 0.005],
    adxLen:    [14],
    adxMin:    [0, 20, 25],
    atrLen:    [14],
    stopMult:  [2, 3],
    trailMult: [3, 4, 6],
    maxBarras: [0]
  }
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

function idxDeFecha(d, ms) {
  let lo = 0, hi = d.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (d.ts[m] < ms) lo = m + 1; else hi = m; }
  return lo;
}

// Puntuacion robusta: premia PF en AMBOS periodos y consistencia anual,
// castiga drawdown. No descarta a los perdedores: los ordena por debajo, para
// poder leer el mapa completo del barrido.
function puntuar(is, oos, minOps) {
  if (is.ops < minOps * 0.5 || oos.ops < 8) return -Infinity;
  const todos = [...Object.values(is.porAnio), ...Object.values(oos.porAnio)];
  if (!todos.length) return -Infinity;
  const positivos = todos.filter(a => a.pnl > 0).length / todos.length;
  const pfMin = Math.min(is.pf, oos.pf);
  const ddMax = Math.max(is.maxDD, oos.maxDD);
  return (Math.min(pfMin, 3) * 3) + (positivos * 3) - (ddMax / 20);
}
const apto = r => r.is.retorno > 0 && r.oos.retorno > 0 && r.all.pf > 1.2 && r.all.maxDD < 45;

function correr(familia, intervalo, top = 12, extra = {}) {
  const d = E.cargar('BTCUSDT', intervalo);
  const cache = S.crearCache(d);
  const corte = idxDeFecha(d, CORTE_OOS);
  const fn = S.familias[familia];
  const rejilla = { ...REJILLAS[familia], ...extra };
  const combos = combinaciones(rejilla);
  const minOps = Math.max(25, Math.round(d.n / 900));

  const res = [];
  for (const p of combos) {
    if (p.rapida !== undefined && p.rapida >= p.lenta) continue;
    const is  = E.backtest(d, fn(d, cache, p), { ...CFG, desde: 0,     hasta: corte });
    const oos = E.backtest(d, fn(d, cache, p), { ...CFG, desde: corte, hasta: d.n  });
    const all = E.backtest(d, fn(d, cache, p), { ...CFG });
    const score = puntuar(is, oos, minOps);
    if (score === -Infinity) continue;
    res.push({ p, is, oos, all, score });
  }
  res.sort((a, b) => b.score - a.score);
  return {
    d, combos: combos.length, validos: res.length, aptos: res.filter(apto).length,
    res: res.slice(0, top), todos: res, corte, cache, fn
  };
}

const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(1);
function linea(r, i) {
  const { p, is, oos, all } = r;
  const anios = Object.entries(all.porAnio).map(([a, v]) => `${a}:${fmt(v.pnl / 100)}`).join(' ');
  return `#${String(i + 1).padStart(2)} ${apto(r) ? '[APTO]' : '      '} score ${r.score.toFixed(2)}  ${JSON.stringify(p)}
     TODO  ret ${fmt(all.retorno).padStart(9)}%  CAGR ${fmt(all.cagr).padStart(6)}%  PF ${all.pf.toFixed(2)}  DD ${all.maxDD.toFixed(1)}%  ops ${all.ops}  WR ${all.winRate.toFixed(1)}%  Sharpe ${all.sharpe.toFixed(2)}
     IS    ret ${fmt(is.retorno).padStart(9)}%  PF ${is.pf.toFixed(2)}  DD ${is.maxDD.toFixed(1)}%  ops ${is.ops}
     OOS   ret ${fmt(oos.retorno).padStart(9)}%  PF ${oos.pf.toFixed(2)}  DD ${oos.maxDD.toFixed(1)}%  ops ${oos.ops}
     L ${all.largos.ops} ops PF ${all.largos.pf.toFixed(2)} | S ${all.cortos.ops} ops PF ${all.cortos.pf.toFixed(2)}
     año  ${anios}`;
}

if (require.main === module) {
  const familia = process.argv[2], intervalo = process.argv[3] || '60';
  const top = +(process.argv[4] || 10);
  const t0 = Date.now();
  const out = correr(familia, intervalo, top);
  console.log(`\n══ ${familia} · BTCUSDT ${intervalo}m · ${out.combos} combinaciones · ${out.validos} evaluadas · ${out.aptos} APTAS · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out.res.forEach((r, i) => console.log(linea(r, i)));
  if (!out.res.length) console.log('  (ninguna combinacion genero operaciones suficientes)');
}

module.exports = { correr, combinaciones, idxDeFecha, puntuar, linea, CFG, CORTE_OOS, REJILLAS };
