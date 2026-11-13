const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

function parseArgs(argv) {
  const args = {
    source: path.join(process.cwd(), "portflow.db"),
    reset: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--reset") {
      args.reset = true;
      continue;
    }
    if (value === "--source" && argv[i + 1]) {
      args.source = path.resolve(argv[++i]);
      continue;
    }
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function rowsToInsertClause(rows, columns) {
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  return rows.map(row => ({
    sql: `INSERT INTO ${row.table} (${columns.join(",")}) VALUES ${placeholders}`,
    values: columns.map(col => row[col]),
  }));
}

async function main() {
  const { source, reset } = parseArgs(process.argv);
  const tursoUrl = requireEnv("TURSO_DATABASE_URL");
  const tursoAuthToken = requireEnv("TURSO_AUTH_TOKEN");

  if (!fs.existsSync(source)) {
    throw new Error(`Source database not found: ${source}`);
  }

  const local = new Database(source, { readonly: true });
  const remote = createClient({ url: tursoUrl, authToken: tursoAuthToken });

  const tables = ["users", "portfolio", "watchlist", "sip_config", "trade_history"];
  const schema = {
    users: ["id", "email", "password", "name", "created_at"],
    portfolio: ["id", "user_id", "ticker", "shares", "avg_price", "notes", "added_at"],
    watchlist: ["id", "user_id", "ticker", "added_at"],
    sip_config: ["id", "user_id", "max_budget", "levels", "updated_at"],
    trade_history: ["id", "user_id", "exchange", "ticker", "type", "shares", "price", "amount", "notes", "traded_at"],
  };

  try {
    if (reset) {
      for (const table of [...tables].reverse()) {
        await remote.execute(`DELETE FROM ${table}`);
      }
    }

    for (const table of tables) {
      const rows = local.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all();
      if (!rows.length) continue;
      const columns = schema[table];
      const statements = rowsToInsertClause(rows.map(row => ({ table, ...row })), columns);
      for (const stmt of statements) {
        await remote.execute({ sql: stmt.sql, args: stmt.values });
      }
      console.log(`Copied ${rows.length} rows into ${table}`);
    }

    console.log("Migration complete.");
  } finally {
    local.close();
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
});
