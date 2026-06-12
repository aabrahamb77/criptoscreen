# Playbook de integración — CVD + LXR + bot de paper trading

Guía para implementar con **Claude Code** sobre este repo (`scalp-screener`, Node/Express
+ libsql, lógica de screener en `public/index.html`). Hecha a medida de tu código actual.

Ábrelo en Claude Code y pídele: *"Sigue LXR_INTEGRATION.md paso a paso, confirmando
cada bloque antes de aplicarlo."* Los archivos nuevos ya están creados; lo que falta
es el **cableado** dentro de `index.html` y `server.js`.

---

## Lo que ya viene hecho (no hay que crearlo)

- `bot/` — servicio Node de paper trading LXR (config, metrics, bybit, strategy, paperBroker, index). Ver `bot/README.md`.
- `public/lxr.js` — módulo de navegador con las métricas (CVD, divergencia, funding z-score, liquidation pressure, ATR, composite score) y la estrategia LXR. Expone `window.LXR`.

## Lo que falta cablear (tareas para Claude Code)

### Tarea 1 — Cargar `lxr.js` en el frontend
En `public/index.html`, añade **antes** del `<script>` principal (el que empieza
cerca de la línea 1180):

```html
<script src="/lxr.js"></script>
```

### Tarea 2 — Añadir order flow real (CVD) al WebSocket
Hoy `connectLiqWS()` (≈ línea 1695) solo se suscribe a liquidaciones. Hay que:

1. Suscribirse también a `publicTrade.{symbol}` y volcar cada trade en `LXR.CVD`.
2. Migrar el topic de liquidaciones del **deprecado** `liquidation.` al actual
   `allLiquidation.` (el antiguo ya casi no emite; por eso caes al modo "inferido por OI").

En la construcción de topics (≈ línea 1698) cambia:

```js
// ANTES
const allTopics = top50.map(s => `liquidation.${s}USDT`);
// DESPUÉS
const allTopics = top50.flatMap(s => [`allLiquidation.${s}USDT`, `publicTrade.${s}USDT`]);
```

En `ws.onmessage` (≈ línea 1724) reemplaza el bloque de parseo por uno que
distinga ambos topics. Ojo: en `allLiquidation` **`data` es un array** y los
campos son `s,S,v,p,T` (no `symbol,side,size,price`):

```js
const msg = JSON.parse(e.data);
if (!msg.topic || !msg.data) return;

// --- order flow para CVD ---
if (msg.topic.startsWith('publicTrade.')) {
  const sym = msg.topic.split('.')[1].replace('USDT','');
  for (const t of msg.data) LXR.CVD.push(sym, +t.T, t.S, +t.v, +t.p);
  return;
}

// --- liquidaciones reales ---
if (msg.topic.startsWith('allLiquidation.')) {
  const list = Array.isArray(msg.data) ? msg.data : [msg.data];
  for (const d of list) {
    const usdVal = (+d.v) * (+d.p);
    if (!usdVal || isNaN(usdVal)) continue;
    liqEvents.unshift({
      symbol: (d.s || '').replace('USDT',''),
      // Bybit: S='Sell' => largo liquidado; S='Buy' => corto liquidado
      isLong: d.S === 'Sell',
      usdVal, ts: +d.T,
    });
  }
  if (liqEvents.length > 300) liqEvents.length = 300;
  updateLiqBar();
  return;
}
```

> ⚠️ **Verifica la convención `isLong`** con datos reales un par de minutos.
> Tu código previo usaba `isLong: d.side === 'Buy'` (lo contrario). El estándar de
> `allLiquidation` es `S='Sell'` → largo liquidado. Ajusta solo si lo ves invertido.

### Tarea 3 — Calcular CVD por fila del screener
En `fetchSymbolData()` / `loadData()` (≈ 1246–1305), añade a cada `row` el CVD
reciente para mostrarlo como columna:

```js
const now = Date.now();
const trades = LXR.CVD.get(t.symbol.replace('USDT',''));
const cvd1m  = LXR.metrics.cvdFromTrades(trades, now - 60_000);
const cvd5m  = LXR.metrics.cvdFromTrades(trades, now - 300_000);
// ...añade  cvd1m, cvd5m  al objeto que retorna el map de loadData()
```

Luego añade la columna en la tabla (cabecera ≈ línea 909 junto a las demás `<th>`,
y la celda en el render de filas ≈ línea 1846). Colorea verde/rojo según signo.

### Tarea 4 — Señales LXR en la pestaña Lab
LXR es de reversión y conviene evaluarla **solo cuando hay cascada** (ahorra REST).
Buen disparador: cuando llega una liquidación grande para un símbolo, evalúa LXR
para ese símbolo. Necesita velas de **1 minuto** (las que ya pides son 1h/5m), así
que añade una llamada puntual:

```js
async function evalLXR(symbolNoUSDT) {
  const symbol = symbolNoUSDT + 'USDT';
  const now = Date.now();
  const [kRes, oiRes] = await Promise.all([
    bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=60`),
    bybitGet(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=10`),
  ]);
  const klines = (kRes.result?.list||[]).slice().reverse()
    .map(k => ({ high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
  const oiSeries = (oiRes.result?.list||[]).map(x => ({ oi:+x.openInterest })).reverse();

  const sig = LXR.evaluate({
    symbol: symbolNoUSDT, klines, oiSeries,
    fundingHist: [], currentFunding: 0,                 // (opcional, ver Tarea 5)
    trades: LXR.CVD.get(symbolNoUSDT),
    liqs: LXR.liqEventsToInput(liqEvents, symbolNoUSDT),
    nowMs: now,
  });
  if (sig) renderLXRCard(sig);   // píntalo como tarjeta en el Lab
  return sig;
}
```

Crea `renderLXRCard(sig)` reutilizando el estilo de tus tarjetas del Lab
(símbolo, `sig.side`, `sig.score`, `sig.reason`, niveles `sig.stop`/`sig.takeProfit`).

### Tarea 5 — (Opcional) funding z-score real
Para que la confluencia de funding sume, pásale histórico. Lo más barato es ir
acumulando el funding actual de cada ticker en un `Map` por símbolo en cada
`pollSnapshots()`, o llamar a `/v5/market/funding/history?...&limit=60` dentro de
`evalLXR`. Sin esto, LXR funciona igual (solo no suma el +10 de funding).

### Tarea 6 — Montar el bot en el servidor y exponer stats
En `server.js`, tras crear `app`:

```js
const lxrBot = require('./bot');
if (process.env.LXR_BOT === '1') lxrBot.startBot();   // actívalo con LXR_BOT=1
app.get('/api/bot/stats', (req, res) => res.json(lxrBot.getState()));
```

Instala la dependencia del WebSocket del bot: `npm i ws`.
Arranque alternativo (proceso aparte): `node bot/index.js`.

**Panel ya maquetado:** `public/bot.html` es un dashboard completo y autónomo
(equity, retorno, PnL, win-rate, profit factor, R medio, posiciones abiertas,
señales LXR y operaciones cerradas). Funciona en `http://localhost:3000/bot.html`
sin tocar nada: consulta `/api/bot/stats` cada 5 s y, si el bot no está iniciado,
muestra datos de ejemplo para ver la maqueta. Para integrarlo en la pestaña Lab,
o bien lo embebes con `<iframe src="/bot.html">`, o portas su bloque `<script>` y
las secciones HTML al Lab (el CSS ya usa tu paleta: `#07090b`, `#00c878`, `#0088ff`).

### Tarea 7 — Semáforo de régimen en el screener
`public/lxr.js` ahora expone `LXR.ind.regime(highs,lows,closes)` y
`LXR.ui.regimeBadge(reg)`. En `loadData()`, además de las velas que ya pides,
calcula el régimen por símbolo con las velas de 1h (`k1h`) y guarda `row.regime`.
Pinta el badge en una columna nueva o junto al símbolo:

```js
row.regime = LXR.ind.regime(k1h.map(k=>+k[2]), k1h.map(k=>+k[3]), k1h.map(k=>+k[4]));
// en el render de la fila:  ...${LXR.ui.regimeBadge(row.regime)}
```

Úsalo también como filtro: por ejemplo, ocultar señales de reversión cuando el
símbolo está en `trend`.

### Tarea 8 — Columna de fuerza relativa vs BTC
Guarda los cierres de BTC una vez por ciclo y calcula RS por símbolo:

```js
const btcCloses = /* cierres 1h de BTCUSDT */;
row.rs = LXR.ind.relativeStrength(symCloses1h, btcCloses, 24); // >0 más fuerte que BTC
```

Añade columna "RS vs BTC" (verde si >0, rojo si <0). Sirve para elegir longs en
las más fuertes y shorts en las más débiles.

### Tarea 9 — Basis y sizing
- **Basis**: el ticker de Bybit trae `indexPrice`. `row.basis = LXR.ind.basis(price, +t.indexPrice)`.
  Prima alta = perps caros (euforia); útil como filtro de sobreextensión.
- **Calculadora de sizing**: al hacer hover/click en una fila, muestra el tamaño
  sugerido con `riesgo% × equity / distancia_al_stop` (mismo cálculo que el bot,
  ver `bot/risk.js → suggestSize`).

### Heatmap de liquidaciones, régimen de mercado y circuit breaker
Ya están **en el panel del bot** (`/bot.html`, embebido en la pestaña 🤖 Bot):
clusters de liquidación de BTC, régimen por símbolo, régimen de BTC, PnL del día,
expectancy y aviso de circuit breaker. Se alimentan de `/api/bot/stats`, así que
solo necesitas tener el bot corriendo (Tarea 6). Si quieres el heatmap también en
el Screener, reutiliza `LXR.ind.liquidationHeatmap(klines, price)`.

---

## Orden sugerido y verificación
1. Tareas 1–2 → abre la web, confirma en consola que llegan mensajes `publicTrade`
   y `allLiquidation` (sin errores de parseo).
2. Tarea 3 → la columna CVD se llena y cambia de color.
3. Tarea 4 → fuerza el umbral bajándolo en `LXR.CFG` para ver tarjetas y luego
   vuelve a 60.
4. Tarea 6 → `LXR_BOT=1 npm start`, mira los logs `[ABIERTA]` y `/api/bot/stats`.

## Notas
- Todo es paper trading / análisis. No es asesoramiento financiero.
- Si Turso está configurado (`.env`), los trades del bot se guardan en `paper_trades`.
- Mantén pocos símbolos al principio (`LXR_SYMBOLS`) para no chocar con rate-limits.
