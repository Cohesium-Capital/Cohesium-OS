// run-sql-prod.ts : execute a .sql file against the PRODUCTION database.
//   npx tsx scripts/run-sql-prod.ts <path-to-sql-file>
// Uses PROD_DATABASE_URL from .env.local. Refuses to run without it.
// Echoes the target host/db first so you can confirm before it writes.

import { readFileSync } from "node:fs";
import { Client } from "pg";

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error("PROD_DATABASE_URL is not set (web/.env.local).");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx scripts/run-sql-prod.ts <file.sql>");
  process.exit(1);
}

const sql = readFileSync(file, "utf8");

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const who = await client.query(
      `select current_database() as db, current_user as usr`,
    );
    console.log(`TARGET: db=${who.rows[0].db} user=${who.rows[0].usr}`);
    console.log(`FILE:   ${file}\n`);
    const res = await client.query(sql);
    const results = Array.isArray(res) ? res : [res];
    for (const r of results) {
      if (r.command) console.log(`${r.command}: ${r.rowCount ?? 0} rows`);
      if (r.rows?.length) console.table(r.rows);
    }
    console.log("\nOK");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
