// Descarga klines historicos de Bybit (perpetuo lineal) y los guarda en CSV.
// Uso: node backtest/fetch-bybit.js BTCUSDT 60 2020-01-01
const fs = require('fs');
const path = require('path');

const SYMBOL   = process.argv[2] || 'BTCUSDT';
const INTERVAL = process.argv[3] || '60';          // 15, 30, 60, 120, 240, 360, 720, D
const DESDE    = Date.parse((process.argv[4] || '2019-01-01') + 'T00:00:00Z');

const MS_POR_VELA = {
  '1': 6e4, '3': 18e4, '5': 3e5, '15': 9e5, '30': 18e5, '60': 36e5,
  '120': 72e5, '240': 144e5, '360': 216e5, '720': 432e5, 'D': 864e5
}[INTERVAL];
if (!MS_POR_VELA) { console.error(`intervalo no soportado: ${INTERVAL}`); process.exit(1); }

const dormir = ms => new Promise(r => setTimeout(r, ms));

async function pagina(inicio) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${SYMBOL}`
            + `&interval=${INTERVAL}&start=${inicio}&limit=1000`;
  for (let intento = 0; intento < 5; intento++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j.retCode !== 0) throw new Error(j.retMsg);
      return j.result.list || [];
    } catch (e) {
      if (intento === 4) throw e;
      await dormir(1000 * (intento + 1));
    }
  }
}

(async () => {
  const velas = new Map();               // ts -> [ts,o,h,l,c,v]
  let cursor = DESDE;
  const ahora = Date.now();

  while (cursor < ahora) {
    const lote = await pagina(cursor);
    if (!lote.length) break;
    // Bybit devuelve descendente
    for (const f of lote) {
      const ts = Number(f[0]);
      velas.set(ts, [ts, +f[1], +f[2], +f[3], +f[4], +f[5]]);
    }
    const maxTs = Math.max(...lote.map(f => Number(f[0])));
    const siguiente = maxTs + MS_POR_VELA;
    if (siguiente <= cursor) break;
    cursor = siguiente;
    process.stdout.write(`\r${SYMBOL} ${INTERVAL}m  ${velas.size} velas  ...${new Date(maxTs).toISOString().slice(0,10)}`);
    await dormir(120);
  }

  const ordenadas = [...velas.values()].sort((a, b) => a[0] - b[0]);
  // descarta la ultima vela (aun en formacion)
  ordenadas.pop();

  const destino = path.join(__dirname, 'data', `${SYMBOL}_${INTERVAL}.csv`);
  fs.writeFileSync(destino,
    'ts,open,high,low,close,volume\n' + ordenadas.map(v => v.join(',')).join('\n'));
  console.log(`\n-> ${destino}  ${ordenadas.length} velas  `
    + `${new Date(ordenadas[0][0]).toISOString().slice(0,10)} .. `
    + `${new Date(ordenadas.at(-1)[0]).toISOString().slice(0,10)}`);
})();
