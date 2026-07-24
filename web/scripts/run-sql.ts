// run-sql.ts : execute a .sql file against the DEV database.
//   npx tsx scripts/run-sql.ts <path-to-sql-file>
// Uses DEV_DATABASE_URL from .env.local. Refuses to run without it.

import { readFileSync } from "node:fs";
import { Client } from "pg";

const url = process.env.DEV_DATABASE_URL;
if (!url) {
  console.error("DEV_DATABASE_URL is not set (web/.env.local).");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx scripts/run-sql.ts <file.sql>");
  process.exit(1);
}

const sql = readFileSync(file, "utf8");

async function main() {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const res = await client.query(sql);
    const results = Array.isArray(res) ? res : [res];
    for (const r of results) {
      if (r.command) console.log(`${r.command}: ${r.rowCount ?? 0} rows`);
      if (r.rows?.length) console.table(r.rows);
    }
    console.log("OK");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
