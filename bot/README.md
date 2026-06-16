# bot/ — Servicio de paper trading LXR (Node)

Bot de **paper trading** (simulado, sin claves API, sin órdenes reales) que corre
la estrategia **Liquidation Exhaustion Reversal** sobre datos en vivo de Bybit.
Mismo stack que la app (Node + libsql/Turso).

## Arrancar

```bash
npm i ws            # única dependencia nueva (WebSocket)
node bot/index.js   # arranca el bot standalone
```

Lee `.env` (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN). Si Turso está configurado,
los trades cerrados se guardan en la tabla `paper_trades`, y **al arrancar el
bot se rehidrata**: recupera el historial, el equity (último `equity_after`) y
el estado del día del circuit breaker — un reinicio ya no resetea la cuenta.

Variables opcionales: `LXR_SYMBOLS` (lista separada por comas), `LXR_EQUITY`,
`LXR_WARMUP_SEC` (cobertura mínima del WS antes de abrir posiciones, 120 por defecto).

## Montarlo dentro de tu server.js (sin segundo proceso)

```js
const lxrBot = require('./bot');
lxrBot.startBot();                       // arranca el loop al levantar el server
app.get('/api/bot/stats', (req, res) => res.json(lxrBot.getState()));
```

`getState()` devuelve equity, win-rate, profit factor, posiciones abiertas y las
últimas señales — listo para pintarlo en la pestaña Lab.

## Archivos

| Archivo | Rol |
|---|---|
| `config.js` | Símbolos, ventanas, umbrales, riesgo, régimen, circuit breaker y warmup WS. |
| `metrics.js` | Reexporta las métricas del módulo compartido `public/lxr.js` (única fuente de verdad). |
| `indicators.js` | Reexporta los indicadores compartidos de `public/lxr.js` + expectancy/equityStats (solo Node). |
| `strategy.js` | Wrapper de la señal LXR compartida (`public/lxr.js`) con la config del bot. |
| `strategies.js` | **Multi-estrategia con gating por régimen**: lxr, vwapReclaim, fundingFade, breakoutOiCvd, fakeoutFade, momentumDelta. |
| `risk.js` | **Circuit breaker** (pérdida diaria / racha, rehidratable), **guarda de correlación**, calculadora de sizing. |
| `bybit.js` | REST (klines/OI/funding/tickers/orderbook) + WS (`publicTrade`, `allLiquidation`) con `coverageSec()`. |
| `paperBroker.js` | Sizing por riesgo, fees, **SL/TP intravela** (regla pesimista), trailing, persistencia y **rehidratación** en Turso. |
| `recorder.js` | **Grabación de order flow** en Turso para backtests: CVD por buckets + liquidaciones raw (`LXR_RECORD=1`). |
| `edge.js` | **Capa de edge v2**: semáforo de mercado, filtro de salud por operación y asignación adaptativa por expectancy. |
| `index.js` | Loop principal + `startBot()` / `getState()`. |

### Honestidad de la simulación

- **SL/TP intravela**: los triggers se evalúan contra el máximo/mínimo real de
  los trades del WS desde la última revisión, y el cierre se ejecuta al precio
  del trigger. Si stop y TP se tocan en el mismo intervalo, **cuenta el stop**
  (regla pesimista). Esto elimina el sesgo optimista de evaluar solo el close.
- **Warmup tras (re)conexión del WS**: no se abren posiciones hasta tener
  `LXR_WARMUP_SEC` de cobertura de datos, y el baseline del z-score de
  liquidaciones se acota a la cobertura real (con <5 ventanas el z es 0).
- **fakeoutFade con score dinámico**: pondera OI cayendo, CVD opuesto a la
  ruptura y mecha de rechazo — ya no pasa el filtro automáticamente.

### Capa de edge (bot v2)

Tres controles sobre cada operación (`LXR_EDGE=0` los desactiva):

1. **Semáforo de mercado** (server-side): BTC en ×ATR + cascadas de liquidación
   + chop direccional + funding estirado → riesgo 0-100. En 🔴 (≥60) no se abre
   nada; en 🟡 (30-59) se opera a **mitad de tamaño**; en 🟢 tamaño normal.
2. **Filtro de salud por operación**: liquidez, CVD a favor, OI con interés,
   funding sin euforia y — solo para estrategias de continuación — alineación
   de temporalidades y no sobre-extensión (las de reversión operan justamente
   la extensión, no se les exige). Salud < `EDGE_MIN_QUALITY` (60%) → la señal
   se descarta y queda registrada en el log.
3. **Asignación adaptativa**: cada trade persiste su estrategia; con ≥15 trades
   y expectancy < −0.05R una estrategia queda **desactivada automáticamente**
   — el bot deja de operar lo que demuestra no funcionar.

`getState().edge` expone el semáforo actual, los descartes (guard/quality/
disabled) y la expectancy por estrategia.

**Criterios de validación antes de pensar en dinero real** (todos a la vez):
n ≥ 100 trades cerrados · profit factor ≥ 1.3 · expectancy ≥ +0.05R · max
drawdown < 10% · y que se sostenga en ≥ 3 semanas con regímenes distintos.
Si no se cumplen, el bot NO es rentable, diga lo que diga una buena semana.

### Grabación de order flow (para backtests)

Las liquidaciones y el CVD solo llegan por WebSocket — no se pueden descargar
después. Con `LXR_RECORD=1` (y Turso configurado) el bot graba:

- `flow_cvd`  : trades agregados por buckets (`FLOW_BUCKET_SEC`, 15s por defecto)
  con buy/sell vol, nº de trades, last/high/low.
- `flow_liqs` : liquidaciones raw (ts, símbolo, lado, precio, notional).

Retención `FLOW_RETENTION_DAYS` (14d por defecto, poda automática cada 6h).
Con unas semanas de datos podrás reproducir cascadas pasadas y backtestear
LXR/fakeoutFade con order flow real. `getState().recorder` expone el estado.

## Estrategias y régimen

Cada ciclo clasifica el régimen de cada símbolo (ADX + efficiency ratio + ATR%) y
**solo activa las estrategias adecuadas**:

| Régimen | Estrategias activas |
|---|---|
| `trend` | breakoutOiCvd, momentumDelta (continuación) |
| `volatile` | lxr, vwapReclaim, fundingFade (reversión) |
| `range` | fakeoutFade, fundingFade, lxr |

Además, antes de abrir: el **circuit breaker** corta el día si se supera la pérdida
máxima (`MAX_DAILY_LOSS_PCT`) o la racha de pérdidas (`MAX_LOSS_STREAK`), y la
**guarda de correlación** evita amontonar posiciones del mismo lado o pelearse con
la tendencia de BTC.

`getState()` ahora devuelve también: `circuitBreaker`, `btcRegime`, `regimes`
(por símbolo), `heatmaps` (clusters de liquidación) y `expectancy` — todo lo que
pinta el panel `/bot.html`.

## Convención de liquidaciones (importante)

En el stream `allLiquidation` de Bybit, `side` es el lado de la orden que cierra
la posición liquidada:
- `side: "Sell"` → se liquidó un **largo** (venta forzada, presión bajista).
- `side: "Buy"`  → se liquidó un **corto** (compra forzada, presión alcista).

LXR compra tras cascadas de largos y vende tras cascadas de cortos. Si al ver
datos reales notas la dirección invertida, ese es el único punto a girar.

> ⚠️ Paper trading y herramienta de análisis. No es asesoramiento financiero.
> Valídalo semanas antes de pensar en dinero real.
