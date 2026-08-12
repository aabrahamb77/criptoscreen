const { createClient } = require('@libsql/client');

// La app funciona sin Turso configurado (fallback: solo localStorage en el navegador).
// Cuando TURSO_DATABASE_URL/TURSO_AUTH_TOKEN están presentes, se sincroniza un
// respaldo en servidor para que el historial sobreviva a límites/limpiezas del navegador.
const url       = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

let client = null;
if (url && authToken) {
  client = createClient({ url, authToken });
} else {
  console.log('Turso no configurado (faltan TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) — persistencia en servidor desactivada.');
}

let ready = null;
function init() {
  if (!client) return Promise.resolve(false);
  if (!ready) {
    ready = client.execute(`
      CREATE TABLE IF NOT EXISTS sync_data (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        track_history TEXT NOT NULL DEFAULT '{}',
        strat_signals TEXT NOT NULL DEFAULT '[]',
        track_ledger TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )
    `)
      // migración para tablas creadas antes del libro de detecciones
      .then(() => client.execute(`ALTER TABLE sync_data ADD COLUMN track_ledger TEXT NOT NULL DEFAULT '[]'`).catch(() => {}))
      .then(() => client.execute(`ALTER TABLE sync_data ADD COLUMN favorites TEXT NOT NULL DEFAULT '[]'`).catch(() => {}))
      .then(() => client.execute(`ALTER TABLE sync_data ADD COLUMN conf_signals TEXT NOT NULL DEFAULT '[]'`).catch(() => {}))
      // snapshots de precio cada 5 min (para resolver señales con la pestaña cerrada)
      .then(() => client.execute(`
        CREATE TABLE IF NOT EXISTS price_snaps (
          ts INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          oi REAL,
          PRIMARY KEY (symbol, ts)
        )
      `))
      .then(() => client.execute(`CREATE INDEX IF NOT EXISTS idx_price_snaps_ts ON price_snaps (ts)`).catch(() => {}))
      .then(() => true)
      .catch(err => {
        console.error('Turso init error:', err.message);
        return false;
      });
  }
  return ready;
}

// El respaldo sincroniza SOLO los favoritos. Antes viajaban también
// track_history, strat_signals, track_ledger y conf_signals: la respuesta
// pesaba 962 KB comprimidos y se pedía en cada carga de página, así que abrir
// el screener costaba ~1,1 MB de egress y los 5 GB del plan gratuito de Render
// se agotaban en ~4.600 visitas. Con solo los favoritos, <1 KB.
//
// Las columnas viejas NO se leen ni se sobrescriben: se quedan intactas en
// Turso por si algún día quieres recuperar ese histórico. Ocupan espacio en la
// base, no en tu ancho de banda.
async function loadSync() {
  if (!await init()) return null;
  const res = await client.execute('SELECT favorites, updated_at FROM sync_data WHERE id = 1');
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    favorites: JSON.parse(row.favorites || '[]'),
    updatedAt: row.updated_at,
  };
}

async function saveSync(favorites) {
  if (!await init()) return false;
  await client.execute({
    sql: `
      INSERT INTO sync_data (id, favorites, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        favorites  = excluded.favorites,
        updated_at = excluded.updated_at
    `,
    args: [JSON.stringify(favorites || []), Date.now()],
  });
  return true;
}

// ── Snapshots de precio (job de server.js cada 5 min) ───────────────────────

async function savePriceSnaps(ts, rows) {
  if (!await init()) return false;
  const stmts = rows.map(r => ({
    sql: 'INSERT OR REPLACE INTO price_snaps (ts, symbol, price, oi) VALUES (?, ?, ?, ?)',
    args: [ts, r.symbol, r.price, r.oi ?? null],
  }));
  await client.batch(stmts, 'write');
  return true;
}

async function prunePriceSnaps(beforeTs) {
  if (!await init()) return false;
  await client.execute({ sql: 'DELETE FROM price_snaps WHERE ts < ?', args: [beforeTs] });
  return true;
}

// Precio más cercano a `ts` (dentro de ±tolMs) para un símbolo.
async function priceAt(symbol, ts, tolMs) {
  if (!await init()) return null;
  const res = await client.execute({
    sql: `SELECT ts, price FROM price_snaps
          WHERE symbol = ? AND ts BETWEEN ? AND ?
          ORDER BY ABS(ts - ?) LIMIT 1`,
    args: [symbol, ts - tolMs, ts + tolMs, ts],
  });
  if (!res.rows.length) return null;
  return { symbol, ts: Number(res.rows[0].ts), price: Number(res.rows[0].price) };
}

// Serie de precios desde `from` para una lista de símbolos (backfill del frontend).
async function priceSeries(symbols, from) {
  if (!await init()) return [];
  const placeholders = symbols.map(() => '?').join(',');
  const res = await client.execute({
    sql: `SELECT ts, symbol, price FROM price_snaps
          WHERE ts >= ? AND symbol IN (${placeholders})
          ORDER BY ts ASC`,
    args: [from, ...symbols],
  });
  return res.rows.map(r => ({ ts: Number(r.ts), symbol: String(r.symbol), price: Number(r.price) }));
}

module.exports = { enabled: () => !!client, loadSync, saveSync, savePriceSnaps, prunePriceSnaps, priceAt, priceSeries };
