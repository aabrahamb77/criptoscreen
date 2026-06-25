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
      .then(() => true)
      .catch(err => {
        console.error('Turso init error:', err.message);
        return false;
      });
  }
  return ready;
}

async function loadSync() {
  if (!await init()) return null;
  const res = await client.execute('SELECT track_history, strat_signals, track_ledger, favorites, updated_at FROM sync_data WHERE id = 1');
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    trackHistory: JSON.parse(row.track_history),
    stratSignals: JSON.parse(row.strat_signals),
    trackLedger: JSON.parse(row.track_ledger || '[]'),
    favorites: JSON.parse(row.favorites || '[]'),
    updatedAt: row.updated_at,
  };
}

async function saveSync(trackHistory, stratSignals, trackLedger, favorites) {
  if (!await init()) return false;
  await client.execute({
    sql: `
      INSERT INTO sync_data (id, track_history, strat_signals, track_ledger, favorites, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        track_history = excluded.track_history,
        strat_signals = excluded.strat_signals,
        track_ledger  = excluded.track_ledger,
        favorites     = excluded.favorites,
        updated_at    = excluded.updated_at
    `,
    args: [JSON.stringify(trackHistory), JSON.stringify(stratSignals), JSON.stringify(trackLedger || []), JSON.stringify(favorites || []), Date.now()],
  });
  return true;
}

module.exports = { enabled: () => !!client, loadSync, saveSync };
