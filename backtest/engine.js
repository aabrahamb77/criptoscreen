// Motor de backtest bar-a-bar con ejecucion realista.
const fs = require('fs');
const path = require('path');

// ── Carga de datos ──────────────────────────────────────────────────────────
function cargar(symbol, interval) {
  const txt = fs.readFileSync(path.join(__dirname, 'data', `${symbol}_${interval}.csv`), 'utf8');
  const filas = txt.trim().split('\n').slice(1);
  const n = filas.length;
  const d = {
    n, ts: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n),
    low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n)
  };
  for (let i = 0; i < n; i++) {
    const c = filas[i].split(',');
    d.ts[i] = +c[0]; d.open[i] = +c[1]; d.high[i] = +c[2];
    d.low[i] = +c[3]; d.close[i] = +c[4]; d.volume[i] = +c[5];
  }
  return d;
}

// ── Indicadores (Float64Array alineado, NaN al inicio) ──────────────────────
const nan = n => new Float64Array(n).fill(NaN);

function sma(src, len) {
  const n = src.length, out = nan(n); let suma = 0;
  for (let i = 0; i < n; i++) {
    suma += src[i];
    if (i >= len) suma -= src[i - len];
    if (i >= len - 1) out[i] = suma / len;
  }
  return out;
}

function ema(src, len) {
  const n = src.length, out = nan(n), k = 2 / (len + 1); let prev = NaN, suma = 0;
  for (let i = 0; i < n; i++) {
    if (i < len - 1) { suma += src[i]; continue; }
    if (i === len - 1) { suma += src[i]; prev = suma / len; out[i] = prev; continue; }
    prev = src[i] * k + prev * (1 - k); out[i] = prev;
  }
  return out;
}

function rma(src, len) {                       // media de Wilder
  const n = src.length, out = nan(n); let prev = NaN, suma = 0, cuenta = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!isFinite(v)) continue;
    if (cuenta < len) {
      suma += v; cuenta++;
      if (cuenta === len) { prev = suma / len; out[i] = prev; }
      continue;
    }
    prev = (prev * (len - 1) + v) / len; out[i] = prev;
  }
  return out;
}

function trueRange(d) {
  const n = d.n, out = nan(n); out[0] = d.high[0] - d.low[0];
  for (let i = 1; i < n; i++)
    out[i] = Math.max(d.high[i] - d.low[i],
                      Math.abs(d.high[i] - d.close[i - 1]),
                      Math.abs(d.low[i] - d.close[i - 1]));
  return out;
}
const atr = (d, len) => rma(trueRange(d), len);

function rsi(src, len) {
  const n = src.length, up = nan(n), dn = nan(n);
  up[0] = 0; dn[0] = 0;
  for (let i = 1; i < n; i++) {
    const ch = src[i] - src[i - 1];
    up[i] = Math.max(ch, 0); dn[i] = Math.max(-ch, 0);
  }
  const mu = rma(up, len), md = rma(dn, len), out = nan(n);
  for (let i = 0; i < n; i++) {
    if (!isFinite(mu[i])) continue;
    out[i] = md[i] === 0 ? 100 : 100 - 100 / (1 + mu[i] / md[i]);
  }
  return out;
}

function adx(d, len) {
  const n = d.n, plus = nan(n), minus = nan(n);
  plus[0] = 0; minus[0] = 0;
  for (let i = 1; i < n; i++) {
    const up = d.high[i] - d.high[i - 1], dw = d.low[i - 1] - d.low[i];
    plus[i]  = (up > dw && up > 0) ? up : 0;
    minus[i] = (dw > up && dw > 0) ? dw : 0;
  }
  const tr = rma(trueRange(d), len), mp = rma(plus, len), mm = rma(minus, len);
  const dx = nan(n), dip = nan(n), dim = nan(n);
  for (let i = 0; i < n; i++) {
    if (!isFinite(tr[i]) || tr[i] === 0) continue;
    const dp = 100 * mp[i] / tr[i], dm = 100 * mm[i] / tr[i];
    dip[i] = dp; dim[i] = dm;
    const s = dp + dm;
    dx[i] = s === 0 ? 0 : 100 * Math.abs(dp - dm) / s;
  }
  return { adx: rma(dx, len), diPlus: dip, diMinus: dim };
}

function stdev(src, len) {
  const n = src.length, out = nan(n), m = sma(src, len);
  for (let i = len - 1; i < n; i++) {
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) { const dif = src[j] - m[i]; s += dif * dif; }
    out[i] = Math.sqrt(s / len);
  }
  return out;
}

function maximo(src, len) {
  const n = src.length, out = nan(n);
  for (let i = len - 1; i < n; i++) {
    let mx = -Infinity;
    for (let j = i - len + 1; j <= i; j++) if (src[j] > mx) mx = src[j];
    out[i] = mx;
  }
  return out;
}
function minimo(src, len) {
  const n = src.length, out = nan(n);
  for (let i = len - 1; i < n; i++) {
    let mn = Infinity;
    for (let j = i - len + 1; j <= i; j++) if (src[j] < mn) mn = src[j];
    out[i] = mn;
  }
  return out;
}

// ── Motor ───────────────────────────────────────────────────────────────────
// plan(i, pos, entrada, stop) evaluado al CIERRE de la vela i.
//   -> { dir: 1|-1|0, stopIni: precio (para abrir), stop: precio (trailing), salir: bool }
// La entrada/salida por senal ocurre en la APERTURA de i+1 (sin look-ahead).
function backtest(d, plan, cfg = {}) {
  const comision  = cfg.comision  ?? 0.00055;   // taker Bybit, por lado
  const slippage  = cfg.slippage  ?? 0.0002;    // por lado
  const capital0  = cfg.capital   ?? 10000;
  const riesgoPct = cfg.riesgo    ?? 1.0;       // fraccion del equity comprometida
  const desde     = cfg.desde ?? 0;
  const hasta     = cfg.hasta ?? d.n;
  const coste     = comision + slippage;

  let equity = capital0, pico = capital0, maxDD = 0;
  let pos = 0, entrada = 0, qty = 0, stop = NaN, objetivo = NaN, tsEntrada = 0, barsEntrada = 0;
  const trades = [];

  const abrir = (i, dir, precio, stopIni, tpIni) => {
    const px = precio * (1 + dir * coste);
    qty = (equity * riesgoPct) / px;
    entrada = px; pos = dir; stop = stopIni; objetivo = tpIni ?? NaN;
    tsEntrada = d.ts[i]; barsEntrada = i;
  };
  const cerrar = (i, precio, motivo) => {
    const px = precio * (1 - pos * coste);
    const antes = equity;
    const pnl = (px - entrada) * qty * pos;
    equity += pnl;
    trades.push({
      dir: pos, entrada, salida: px, pnl, pnlPct: pnl / antes * 100,
      tsIn: tsEntrada, tsOut: d.ts[i], barras: i - barsEntrada, motivo, equity
    });
    if (equity > pico) pico = equity;
    const dd = (pico - equity) / pico; if (dd > maxDD) maxDD = dd;
    pos = 0; qty = 0; stop = NaN; objetivo = NaN;
  };

  for (let i = desde; i < hasta; i++) {
    // 1) stop intrabar. Peor caso deliberado: si en la misma vela se tocan
    //    stop y objetivo, se asume que salto primero el stop.
    if (pos !== 0 && isFinite(stop)) {
      if (pos === 1 && d.low[i] <= stop)        cerrar(i, Math.min(stop, d.open[i]), 'stop');
      else if (pos === -1 && d.high[i] >= stop) cerrar(i, Math.max(stop, d.open[i]), 'stop');
    }
    // 2) objetivo intrabar, solo si el stop no salto en esta misma vela
    if (pos !== 0 && isFinite(objetivo)) {
      if (pos === 1 && d.high[i] >= objetivo)      cerrar(i, Math.max(objetivo, d.open[i]), 'objetivo');
      else if (pos === -1 && d.low[i] <= objetivo) cerrar(i, Math.min(objetivo, d.open[i]), 'objetivo');
    }

    // 3) senal al cierre de i
    const s = plan(i, pos, entrada, stop);
    if (equity <= capital0 * 0.02) break;                 // ruina
    if (!s) continue;

    if (pos !== 0 && isFinite(s.stop)) {                  // trailing
      if (pos === 1)  stop = Math.max(isFinite(stop) ? stop : -Infinity, s.stop);
      if (pos === -1) stop = Math.min(isFinite(stop) ?  stop :  Infinity, s.stop);
    }

    const sig = i + 1;
    if (sig >= hasta) continue;

    if (pos !== 0 && (s.salir || (s.dir !== 0 && s.dir !== pos)))
      cerrar(sig, d.open[sig], s.salir ? 'senal' : 'reversa');
    if (pos === 0 && s.dir !== 0 && isFinite(s.stopIni))
      abrir(sig, s.dir, d.open[sig], s.stopIni, s.tpIni);
  }
  if (pos !== 0) cerrar(hasta - 1, d.close[hasta - 1], 'fin');

  return metricas(trades, capital0, maxDD, d, desde, hasta);
}

function metricas(trades, capital0, maxDD, d, desde, hasta) {
  const n = trades.length;
  const equityFinal = n ? trades[n - 1].equity : capital0;
  const ganan = trades.filter(t => t.pnl > 0), pierden = trades.filter(t => t.pnl <= 0);
  const brutoG = ganan.reduce((a, t) => a + t.pnl, 0);
  const brutoP = -pierden.reduce((a, t) => a + t.pnl, 0);
  const pf = brutoP === 0 ? (brutoG > 0 ? Infinity : 0) : brutoG / brutoP;

  const anios = (d.ts[hasta - 1] - d.ts[desde]) / (365.25 * 864e5);
  const cagr = anios > 0 && equityFinal > 0 ? (Math.pow(equityFinal / capital0, 1 / anios) - 1) * 100 : -100;

  const rets = trades.map(t => t.pnl / (t.equity - t.pnl));
  const media = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const varr  = n ? rets.reduce((a, b) => a + (b - media) ** 2, 0) / n : 0;
  const opsPorAnio = anios > 0 ? n / anios : 0;
  const sharpe = varr > 0 ? (media / Math.sqrt(varr)) * Math.sqrt(opsPorAnio) : 0;

  const porAnio = {};
  for (const t of trades) {
    const a = new Date(t.tsOut).getUTCFullYear();
    porAnio[a] = porAnio[a] || { pnl: 0, ops: 0, gan: 0 };
    porAnio[a].pnl += t.pnl; porAnio[a].ops++; if (t.pnl > 0) porAnio[a].gan++;
  }

  const lado = arr => ({
    ops: arr.length,
    pnl: arr.reduce((a, t) => a + t.pnl, 0),
    wr: arr.length ? arr.filter(t => t.pnl > 0).length / arr.length * 100 : 0,
    pf: (() => {
      const g = arr.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
      const p = -arr.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
      return p ? g / p : (g > 0 ? Infinity : 0);
    })()
  });

  return {
    ops: n, equityFinal, retorno: (equityFinal / capital0 - 1) * 100, cagr,
    pf, maxDD: maxDD * 100, winRate: n ? ganan.length / n * 100 : 0,
    mediaGan: ganan.length ? brutoG / ganan.length : 0,
    mediaPer: pierden.length ? brutoP / pierden.length : 0,
    sharpe, anios, porAnio,
    largos: lado(trades.filter(t => t.dir === 1)),
    cortos: lado(trades.filter(t => t.dir === -1)),
    trades
  };
}

module.exports = {
  cargar, sma, ema, rma, atr, rsi, adx, stdev, maximo, minimo, trueRange,
  backtest, metricas, nan
};
