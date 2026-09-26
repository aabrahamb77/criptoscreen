// Bateria de estres para una configuracion concreta.
// Uso: node backtest/validar.js
const E = require('./engine');
const S = require('./strategies');
const { CFG, idxDeFecha } = require('./run');

const fmt = (n, w = 7) => ((n >= 0 ? '+' : '') + n.toFixed(1)).padStart(w);

// ── retorno compuesto real por año natural ─────────────────────────────────
function porAnioReal(r, capital0) {
  const filas = {};
  let equityPrev = capital0, anioPrev = null;
  for (const t of r.trades) {
    const a = new Date(t.tsOut).getUTCFullYear();
    if (anioPrev === null) anioPrev = a;
    if (a !== anioPrev) {
      filas[anioPrev] = filas[anioPrev] || { ini: equityPrev };
      equityPrev = t.equity - t.pnl;
      filas[anioPrev].fin = equityPrev;
      anioPrev = a;
    }
    filas[a] = filas[a] || { ini: equityPrev, ops: 0, gan: 0 };
    filas[a].ops = (filas[a].ops || 0) + 1;
    if (t.pnl > 0) filas[a].gan = (filas[a].gan || 0) + 1;
    filas[a].fin = t.equity;
  }
  const out = {};
  for (const [a, v] of Object.entries(filas))
    out[a] = { ret: (v.fin / v.ini - 1) * 100, ops: v.ops || 0, gan: v.gan || 0 };
  return out;
}

// ── drawdown sobre la curva de equity de operaciones cerradas ──────────────
function maxRacha(trades) {
  let peor = 0, actual = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { actual++; if (actual > peor) peor = actual; } else actual = 0;
  }
  return peor;
}

// ── Monte Carlo por remuestreo CON REEMPLAZO ───────────────────────────────
// Barajar el orden no cambia el resultado final (el producto es conmutativo),
// solo el drawdown. Para estimar el abanico de resultados posibles hay que
// remuestrear con reemplazo: cada simulacion es una "historia alternativa".
function monteCarlo(trades, capital0, n = 5000) {
  const rets = trades.map(t => t.pnl / (t.equity - t.pnl));
  const m = rets.length;
  const dds = [], finales = [];
  for (let k = 0; k < n; k++) {
    const s = new Array(m);
    for (let i = 0; i < m; i++) s[i] = rets[(Math.random() * m) | 0];
    let eq = capital0, pico = capital0, dd = 0;
    for (const r of s) {
      eq *= (1 + r);
      if (eq > pico) pico = eq;
      const d = (pico - eq) / pico; if (d > dd) dd = d;
    }
    dds.push(dd * 100); finales.push((eq / capital0 - 1) * 100);
  }
  dds.sort((a, b) => a - b); finales.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  return {
    ddMediana: pct(dds, 0.5), dd95: pct(dds, 0.95),
    retMediana: pct(finales, 0.5), ret5: pct(finales, 0.05),
    probPerdida: finales.filter(f => f <= 0).length / finales.length * 100
  };
}

// ── walk-forward por ventanas rodantes ─────────────────────────────────────
function walkForward(d, fn, p, ventanas = 8, cfgBase = CFG) {
  const paso = Math.floor(d.n / ventanas), out = [];
  for (let k = 0; k < ventanas; k++) {
    const a = k * paso, b = k === ventanas - 1 ? d.n : (k + 1) * paso;
    const r = E.backtest(d, fn, { ...cfgBase, desde: a, hasta: b });
    out.push({
      desde: new Date(d.ts[a]).toISOString().slice(0, 7),
      hasta: new Date(d.ts[b - 1]).toISOString().slice(0, 7),
      ret: r.retorno, pf: r.pf, ops: r.ops, dd: r.maxDD
    });
  }
  return out;
}

function evaluar(nombre, familia, intervalo, p, cfgExtra = {}) {
  const d = E.cargar('BTCUSDT', intervalo);
  const c = S.crearCache(d);
  const cfg = { ...CFG, ...cfgExtra };
  const fn = S.familias[familia](d, c, p);
  const r = E.backtest(d, fn, cfg);
  return { d, c, p, r, cfg, fn, nombre, intervalo, familia };
}

function informe(ev) {
  const { d, r, cfg, p, nombre, intervalo } = ev;
  const anios = porAnioReal(r, cfg.capital);
  const L = [];
  L.push(`\n╔═ ${nombre} · BTCUSDT ${intervalo}m ═══════════════════════════════════`);
  L.push(`  parametros ${JSON.stringify(p)}`);
  L.push(`  costes: comision ${(cfg.comision * 100).toFixed(3)}%/lado + slippage ${(cfg.slippage * 100).toFixed(3)}%/lado`);
  L.push(`  ── Resultado global (${r.anios.toFixed(1)} años) ────────────────────`);
  L.push(`  Retorno ${fmt(r.retorno, 9)}%   CAGR ${fmt(r.cagr)}%   Equity ${cfg.capital} -> ${r.equityFinal.toFixed(0)}`);
  L.push(`  Profit Factor ${r.pf.toFixed(2)}   Max DD ${r.maxDD.toFixed(1)}%   Sharpe ${r.sharpe.toFixed(2)}`);
  L.push(`  Operaciones ${r.ops}   Aciertos ${r.winRate.toFixed(1)}%   Racha perdedora max ${maxRacha(r.trades)}`);
  L.push(`  Media ganadora ${r.mediaGan.toFixed(0)} / media perdedora ${r.mediaPer.toFixed(0)}  ->  ratio ${(r.mediaGan / r.mediaPer).toFixed(2)}`);
  L.push(`  LARGOS  ${String(r.largos.ops).padStart(3)} ops  PF ${r.largos.pf.toFixed(2)}  aciertos ${r.largos.wr.toFixed(1)}%  pnl ${fmt(r.largos.pnl, 9)}`);
  L.push(`  CORTOS  ${String(r.cortos.ops).padStart(3)} ops  PF ${r.cortos.pf.toFixed(2)}  aciertos ${r.cortos.wr.toFixed(1)}%  pnl ${fmt(r.cortos.pnl, 9)}`);
  L.push(`  ── Año a año (retorno compuesto real) ──────────────────────────`);
  for (const [a, v] of Object.entries(anios))
    L.push(`  ${a}  ${fmt(v.ret, 8)}%   ${String(v.ops).padStart(3)} ops   ${v.ops ? (v.gan / v.ops * 100).toFixed(0) : 0}% aciertos  ${v.ret > 0 ? '✔' : '✘'}`);
  const negativos = Object.values(anios).filter(v => v.ret <= 0).length;
  L.push(`  -> ${Object.keys(anios).length - negativos}/${Object.keys(anios).length} años positivos`);
  return L.join('\n');
}

function estres(ev) {
  const { d, c, p, r, familia, intervalo, cfg } = ev;
  const L = [];
  L.push(`  ── Estres de costes ────────────────────────────────────────────`);
  for (const mult of [1, 2, 3, 4]) {
    const rr = E.backtest(d, S.familias[familia](d, c, p),
      { ...cfg, comision: cfg.comision * mult, slippage: cfg.slippage * mult });
    L.push(`  costes x${mult}  ret ${fmt(rr.retorno, 9)}%  PF ${rr.pf.toFixed(2)}  DD ${rr.maxDD.toFixed(1)}%`);
  }
  L.push(`  ── Walk-forward (8 ventanas rodantes, sin reoptimizar) ─────────`);
  for (const w of walkForward(d, S.familias[familia](d, c, p), p, 8, cfg))
    L.push(`  ${w.desde}..${w.hasta}  ret ${fmt(w.ret, 8)}%  PF ${w.pf.toFixed(2)}  DD ${w.dd.toFixed(1)}%  ${w.ops} ops  ${w.ret > 0 ? '✔' : '✘'}`);
  const mc = monteCarlo(r.trades, cfg.capital);
  L.push(`  ── Monte Carlo (5000 historias alternativas, remuestreo con reemplazo) ───────`);
  L.push(`  DD mediano ${mc.ddMediana.toFixed(1)}%   DD percentil 95 ${mc.dd95.toFixed(1)}%`);
  L.push(`  Retorno mediano ${fmt(mc.retMediana, 9)}%   percentil 5 ${fmt(mc.ret5, 9)}%`);
  L.push(`  Probabilidad de acabar en perdidas: ${mc.probPerdida.toFixed(1)}%`);
  return L.join('\n');
}

module.exports = { evaluar, informe, estres, porAnioReal, monteCarlo, walkForward, maxRacha };

if (require.main === module) {
  const P = { rapida: 12, lenta: 90, tendLen: 250, adxLen: 14, adxMin: 0, atrLen: 14, stopMult: 1.5, trailMult: 4 };
  const ev = evaluar('Cruce EMA 12/90 + tendencia 250 + trailing ATR', 's2_emaCross', '240', P);
  console.log(informe(ev));
  console.log(estres(ev));
}
