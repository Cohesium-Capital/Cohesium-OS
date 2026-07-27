import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { withRls, asSupabase, resetPoolForTests } from "./rls";
import { createRun, ingestRun } from "../runs/lifecycle";
import { loadOrgIndex, partitionCandidates } from "../sourcing/known";

// Integration test for the runner's transport. The adapter stands between the
// shared ingest pipeline and Postgres, so the only test worth writing runs that
// real pipeline against a real database — a mock would just re-assert the
// adapter's own assumptions.
//
// Requires a local Postgres (`pg_isready`). Skipped, loudly, when absent rather
// than silently passing.

const ADMIN = process.env.TEST_PG_ADMIN_URL ?? "postgres://localhost:5432/postgres";
const DB = "cohesium_rls_test";
const TEST_URL = ADMIN.replace(/\/[^/]*$/, `/${DB}`);

const WORKSPACE_A = "a0000000-0000-0000-0000-00000000000a";
const WORKSPACE_B = "b0000000-0000-0000-0000-00000000000b";
const USER_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const USER_B = "bbbbbbbb-0000-0000-0000-00000000000b";
// A plain member of workspace A. Distinct from USER_B on purpose: B must stay
// a stranger to A so the isolation tests keep testing isolation, while the
// admin tests need someone who IS a member and still gets refused.
const USER_C = "cccccccc-0000-0000-0000-00000000000c";

let available = false;

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: ADMIN });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// node:test evaluates a test's `{ skip }` option when the test is DEFINED,
// which is before this hook runs — so availability is checked at runtime via
// t.skip() inside each test rather than declared up front.
before(async () => {
  try {
    await admin(async (c) => {
      await c.query(`drop database if exists ${DB} with (force)`);
      await c.query(`create database ${DB}`);
    });

    const schema = readFileSync(join(__dirname, "fixture-schema.sql"), "utf8");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      await c.query(schema);
      await c.query(`insert into auth.users (id) values ($1), ($2), ($3)`, [
        USER_A,
        USER_B,
        USER_C,
      ]);
      await c.query(
        `insert into public.profiles (id, role) values ($1,'member'), ($2,'member'), ($3,'member')`,
        [USER_A, USER_B, USER_C],
      );
      await c.query(
        `insert into public.workspace_members (workspace_id, user_id, role, is_default)
         values ($1,$2,'admin',true), ($3,$4,'admin',true)`,
        [WORKSPACE_A, USER_A, WORKSPACE_B, USER_B],
      );
      // C is a plain MEMBER of A. That is what makes the admin tests below
      // meaningful: C can read A's rows, so anything C is refused there is
      // refused for lack of ADMIN, not for lack of membership.
      await c.query(
        `insert into public.workspace_members (workspace_id, user_id, role, is_default)
         values ($1,$2,'member',true)`,
        [WORKSPACE_A, USER_C],
      );
      // Every seeded row names its workspace: migration 031 removed the
      // defaults, so an omission here is a NOT NULL violation exactly as it
      // would be in production.
      await c.query(
        `insert into public.api_tokens (workspace_id, name, token_hash, prefix, owner_id)
         values ($1,'a','hash-a','cin_aaaa',$2), ($3,'b','hash-b','cin_bbbb',$4)`,
        [WORKSPACE_A, USER_A, WORKSPACE_B, USER_B],
      );
    } finally {
      await c.end();
    }

    process.env.SUPABASE_DB_URL = TEST_URL;
    resetPoolForTests();
    available = true;
} catch (e) {
    // Only "there is no Postgres here" is a legitimate skip. Anything else is a
    // real failure and must be visible, not silently turned into a green run.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|password|authentication/i.test(msg)) throw e;
    console.error(`[rls.test] skipping — no local Postgres: ${msg}`);
  }
});

after(async () => {
  if (!available) return;
  resetPoolForTests();
  await admin((c) => c.query(`drop database if exists ${DB} with (force)`));
});

// Returns true when the test should stop; marks it skipped in the report.
const unavailable = (t: { skip: (m: string) => void }): boolean => {
  if (available) return false;
  t.skip("no local Postgres (set TEST_PG_ADMIN_URL)");
  return true;
};

describe("withRls", () => {
  test("assumes the authenticated role and resolves auth.uid()", async (t) => {
    if (unavailable(t)) return;
    // The guard inside withRls already asserts this; reaching the callback at
    // all means the role switch took effect.
    const seen = await withRls(USER_A, async (db) => {
      const { data } = await asSupabase(db).from("profiles").select("id, role");
      return data as { id: string }[];
    });
    assert.ok(Array.isArray(seen));
  });

  test("RLS actually filters — user B cannot see user A's token", async (t) => {
    if (unavailable(t)) return;
    // The real proof that we are NOT running as a bypassrls superuser.
    const asB = await withRls(USER_B, async (db) => {
      const { data } = await asSupabase(db).from("api_tokens").select("id, name, owner_id");
      return data as { name: string }[];
    });
    assert.deepEqual(
      asB.map((t) => t.name),
      ["b"],
    );

    const asA = await withRls(USER_A, async (db) => {
      const { data } = await asSupabase(db).from("api_tokens").select("id, name, owner_id");
      return data as { name: string }[];
    });
    assert.deepEqual(
      asA.map((t) => t.name),
      ["a"],
    );
  });

  test("rolls back the whole transaction when the callback throws", async (t) => {
    if (unavailable(t)) return;
    await assert.rejects(
      withRls(USER_A, async (db) => {
        const { error } = await asSupabase(db)
          .from("organizations")
          .insert([{ name: "Rollback Co", kind: "customer", workspace_id: WORKSPACE_A }])
          .select("id");
        // Assert the write actually succeeded first — otherwise the "no rows
        // afterwards" check below would pass even if inserts were broken.
        assert.equal(error, null);
        throw new Error("boom");
      }),
    );
    const after = await withRls(USER_A, async (db) => {
      const { data } = await asSupabase(db)
        .from("organizations")
        .select("id")
        .eq("name", "Rollback Co");
      return data as unknown[];
    });
    assert.equal(after.length, 0);
  });
});

describe("workspace isolation", () => {
  // The guarantee migration 028 exists to provide: membership decides
  // visibility, so a member of one workspace can neither read nor write
  // another's rows — whatever the application layer does.
  test("a member of one workspace cannot see another's rows", async (t) => {
    if (unavailable(t)) return;

    await withRls(USER_A, async (db) => {
      await asSupabase(db)
        .from("organizations")
        .insert({ name: "A CO", kind: "customer", workspace_id: WORKSPACE_A });
    });
    await withRls(USER_B, async (db) => {
      await asSupabase(db)
        .from("organizations")
        .insert({ name: "B CO", kind: "customer", workspace_id: WORKSPACE_B });
    });

    const names = async (user: string) =>
      withRls(user, async (db) => {
        const { data } = await asSupabase(db).from("organizations").select("name");
        return ((data ?? []) as { name: string }[]).map((r) => r.name);
      });
    const aSees = await names(USER_A);
    const bSees = await names(USER_B);

    assert.ok(aSees.includes("A CO"), "A should see its own row");
    assert.ok(!aSees.includes("B CO"), "A must not see B's row");
    assert.ok(bSees.includes("B CO"), "B should see its own row");
    assert.ok(!bSees.includes("A CO"), "B must not see A's row");
  });

  test("a member cannot write into another workspace", async (t) => {
    if (unavailable(t)) return;

    await assert.rejects(
      () =>
        withRls(USER_B, async (db) => {
          // B knows A's id and tries to plant a row in it anyway.
          const { error } = await asSupabase(db)
            .from("organizations")
            .insert({ name: "SMUGGLED", kind: "customer", workspace_id: WORKSPACE_A });
          if (error) throw new Error(error.message);
        }),
      /row-level security|violates/i,
      "WITH CHECK must refuse a cross-workspace insert",
    );
  });

  test("a plain member cannot rename the workspace", async (t) => {
    if (unavailable(t)) return;

    // This is the bug migration 035 fixed. A policy named "admins update their
    // workspaces" tested is_workspace_member, so every member could rename the
    // firm — and adding a correct admin-only policy alongside it changed
    // nothing, because permissive policies OR together. Reading the new policy
    // suggested it worked; only running it showed otherwise.
    const renamed = await withRls(USER_C, async (db) => {
      const { data } = await asSupabase(db)
        .from("workspaces")
        .update({ name: "Renamed By A Member" })
        .eq("id", WORKSPACE_A)
        .select("id");
      return data ?? [];
    });
    assert.equal(renamed.length, 0, "a member must not be able to rename the workspace");

    const stillNamed = await withRls(USER_A, async (db) => {
      const { data } = await asSupabase(db)
        .from("workspaces")
        .select("name")
        .eq("id", WORKSPACE_A)
        .single();
      return (data as { name: string } | null)?.name;
    });
    assert.notEqual(stillNamed, "Renamed By A Member");
  });

  test("an admin can rename their own workspace but not another's", async (t) => {
    if (unavailable(t)) return;

    const own = await withRls(USER_A, async (db) => {
      const { data } = await asSupabase(db)
        .from("workspaces")
        .update({ name: "Workspace A, renamed" })
        .eq("id", WORKSPACE_A)
        .select("id");
      return data ?? [];
    });
    assert.equal(own.length, 1, "an admin can rename their own workspace");

    // A is an admin — but of A, not of B.
    const other = await withRls(USER_A, async (db) => {
      const { data } = await asSupabase(db)
        .from("workspaces")
        .update({ name: "Hijacked" })
        .eq("id", WORKSPACE_B)
        .select("id");
      return data ?? [];
    });
    assert.equal(other.length, 0, "admin of one workspace is not admin of another");
  });

  test("the prompt profile is member-readable but admin-only to write", async (t) => {
    if (unavailable(t)) return;

    // What this table holds is rendered verbatim into messages sent under the
    // firm's name, so "any member can edit it" is the wrong default even though
    // it is the right one for ordinary data.
    await assert.rejects(
      () =>
        withRls(USER_C, async (db) => {
          const { error } = await asSupabase(db)
            .from("workspace_profile")
            .insert({ workspace_id: WORKSPACE_A, firm_name: "Not Their Firm" });
          if (error) throw new Error(error.message);
        }),
      /row-level security|violates/i,
      "a member must not be able to rewrite the firm's identity",
    );

    await withRls(USER_A, async (db) => {
      const { error } = await asSupabase(db)
        .from("workspace_profile")
        .insert({ workspace_id: WORKSPACE_A, firm_name: "Their Firm" });
      assert.equal(error, null, "an admin can set their own workspace's profile");
    });

    const seen = await withRls(USER_C, async (db) => {
      const { data } = await asSupabase(db)
        .from("workspace_profile")
        .select("firm_name")
        .eq("workspace_id", WORKSPACE_A);
      return (data ?? []) as { firm_name: string }[];
    });
    assert.equal(seen[0]?.firm_name, "Their Firm", "members can still read it");
  });

  test("a write that names no workspace fails instead of landing somewhere", async (t) => {
    if (unavailable(t)) return;

    // The guarantee migration 031 bought. While the bridge defaults existed
    // (029), this insert succeeded and filed the row under whichever workspace
    // the default resolved to — plausible, invisible, and wrong the moment a
    // second tenant exists. It must now be a hard NOT NULL violation, because
    // that is a failure someone can see and fix.
    const { error } = await withRls(USER_A, async (db) =>
      asSupabase(db).from("organizations").insert({ name: "NO WORKSPACE", kind: "customer" }),
    );

    assert.ok(error, "an insert without workspace_id must not succeed");
    // Either refusal is correct, and which one fires is worth knowing: the RLS
    // WITH CHECK evaluates is_workspace_member(null) -> false and rejects the
    // row before the NOT NULL constraint is ever reached. So the policy is the
    // first line of defence and the constraint the backstop — a workspace-less
    // write cannot land even if a table's NOT NULL were somehow dropped.
    assert.match(
      error!.message,
      /row-level security|null value in column "workspace_id"|not-null/i,
      "it must fail on the missing workspace, not something incidental",
    );
  });
});

describe("statement isolation", () => {
  // The pipeline tolerates certain statement failures and carries on — a failed
  // contacts insert is logged, and resolvePromptVersion provokes a unique
  // violation on purpose to detect a race. Without per-statement savepoints the
  // first such failure would abort the transaction, every later statement would
  // fail, and COMMIT would silently roll back while the route reported success.
  test("a failed statement does not poison the transaction", async (t) => {
    if (unavailable(t)) return;

    await withRls(USER_A, async (db) => {
      const supabase = asSupabase(db);

      const bad = await supabase
        .from("organizations")
        .insert([{ name: "Bad Row", kind: "customer", id: "not-a-uuid", workspace_id: WORKSPACE_A }])
        .select("id");
      assert.ok(bad.error, "the invalid insert should report an error");

      // Same transaction, after the failure: must still work.
      const good = await supabase
        .from("organizations")
        .insert([{ name: "Survivor Co", domain: "survivor.test", kind: "customer", workspace_id: WORKSPACE_A }])
        .select("id");
      assert.equal(good.error, null, good.error?.message);
    });

    // And it must actually have committed.
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      const r = await c.query(`select name from public.organizations where domain='survivor.test'`);
      assert.equal(r.rows.length, 1, "the post-failure insert must survive the commit");
      const b = await c.query(`select name from public.organizations where name='Bad Row'`);
      assert.equal(b.rows.length, 0, "the failed insert must not have landed");
    } finally {
      await c.end();
    }
  });
});

describe("the shared pipeline over the adapter", () => {
  test("createRun → ingestRun round-trips a real sourcing run", async (t) => {
    if (unavailable(t)) return;
    const created = await withRls(USER_A, (db) =>
      createRun(asSupabase(db), {
        module: "sourcing",
        workspaceId: WORKSPACE_A,
        executor: "runner",
        createdBy: USER_A,
        label: "adapter test",
        config: {
          mode: "research_customers",
          region: "Testville",
          count: 5,
          kind: "customer",
          msps: [],
        },
      }),
    );
    assert.ok(created.runId);
    assert.ok(created.batchId);
    // prompt_versions insert + promote + retire all went through the adapter.
    assert.ok(created.promptVersionId);
    assert.match(created.prompt, /Testville/);

    const outcome = await withRls(USER_A, (db) =>
      ingestRun(asSupabase(db), {
        runId: created.runId,
        createdBy: USER_A,
        requireEvidence: true,
        rawText: JSON.stringify({
          organizations: [
            {
              name: "Adapter Dental",
              domain: "adapterdental.com",
              hq_city: "Testville",
              hq_state: "TX",
              current_msp_name: "Northwind IT",
              source_url: "https://example.test/case-study",
              confidence: "high",
              contacts: [
                {
                  full_name: "Jane Doe",
                  persona: "owner",
                  title: "Owner",
                  linkedin_url: null,
                  source_url: "https://example.test/jane",
                  confidence: "high",
                },
              ],
            },
            {
              // No source_url → must be rejected under requireEvidence, proving
              // the evidence gate still runs on this transport.
              name: "No Evidence LLC",
              domain: "noevidence.test",
              hq_city: null,
              hq_state: null,
              current_msp_name: null,
              source_url: null,
              confidence: "low",
              contacts: [],
            },
          ],
        }),
      }),
    );

    assert.equal(outcome.ok, true, outcome.error ?? "");
    assert.equal(outcome.inserted, 1, `one contact imported — got ${JSON.stringify(outcome)}`);
    assert.equal(outcome.rejected, 1, "evidence-less org rejected");

    // Verify what actually landed, including the jsonb column — the binding
    // most likely to be wrong on a raw transport.
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      const org = await c.query(
        `select name, domain, hq_state, evidence, current_msp_id from public.organizations where domain='adapterdental.com'`,
      );
      assert.equal(org.rows.length, 1);
      assert.equal(org.rows[0].hq_state, "TX");
      assert.deepEqual(org.rows[0].evidence, [
        { url: "https://example.test/case-study", via: "sourcing" },
      ]);
      // The MSP stub was created and linked.
      assert.ok(org.rows[0].current_msp_id);

      const contact = await c.query(
        `select full_name, enrichment_status, evidence, run_id, batch_id from public.contacts where full_name='Jane Doe'`,
      );
      assert.equal(contact.rows.length, 1);
      assert.equal(contact.rows[0].enrichment_status, "pending");
      assert.equal(contact.rows[0].run_id, created.runId);
      assert.deepEqual(contact.rows[0].evidence, [
        { url: "https://example.test/jane", via: "sourcing" },
      ]);

      const rejected = await c.query(`select payload, reason from public.rejected_ingest`);
      assert.equal(rejected.rows.length, 1);
      assert.match(rejected.rows[0].reason, /source_url/);

      const run = await c.query(`select status, config, ingest_report from public.runs where id=$1`, [
        created.runId,
      ]);
      assert.equal(run.rows[0].status, "review_ready");
      // jsonb round-trip on the config the route wrote.
      assert.equal(run.rows[0].config.region, "Testville");
      assert.equal(run.rows[0].ingest_report.inserted, 1);
    } finally {
      await c.end();
    }
  });

  test("a second ingest of the same run is refused", async (t) => {
    if (unavailable(t)) return;
    const created = await withRls(USER_A, (db) =>
      createRun(asSupabase(db), {
        module: "sourcing",
        workspaceId: WORKSPACE_A,
        executor: "runner",
        createdBy: USER_A,
        label: "double ingest",
        config: { mode: "research_customers", region: "Twice", count: 1, kind: "customer", msps: [] },
      }),
    );
    const payload = JSON.stringify({
      organizations: [
        {
          name: "Once Only Inc",
          domain: "onceonly.test",
          hq_city: null,
          hq_state: null,
          current_msp_name: null,
          source_url: "https://example.test/once",
          confidence: "high",
          contacts: [],
        },
      ],
    });
    const first = await withRls(USER_A, (db) =>
      ingestRun(asSupabase(db), { runId: created.runId, rawText: payload, createdBy: USER_A }),
    );
    assert.equal(first.ok, true, first.error ?? "");

    const second = await withRls(USER_A, (db) =>
      ingestRun(asSupabase(db), { runId: created.runId, rawText: payload, createdBy: USER_A }),
    );
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /already ingested/i);
  });

  test("loadOrgIndex + partitionCandidates see the imported rows", async (t) => {
    if (unavailable(t)) return;
    const index = await withRls(USER_A, (db) =>
      loadOrgIndex(asSupabase(db), "customer", WORKSPACE_A),
    );
    assert.ok(index.rows.length >= 1);

    const { known, fresh } = partitionCandidates(index, [
      { name: "Adapter Dental", domain: "adapterdental.com" },
      { name: "Brand New Co", domain: "brandnew.test" },
    ]);
    assert.deepEqual(
      known.map((k) => k.name),
      ["Adapter Dental"],
    );
    assert.deepEqual(
      fresh.map((f) => f.name),
      ["Brand New Co"],
    );
  });
});

describe("adapter safety", () => {
  test("unsupported operators throw instead of being approximated", async (t) => {
    if (unavailable(t)) return;
    await withRls(USER_A, async (db) => {
      const q = asSupabase(db).from("contacts").select("id") as unknown as {
        or: () => void;
        not: () => void;
      };
      assert.throws(() => q.or(), /not supported/);
      assert.throws(() => q.not(), /not supported/);
    });
  });

  test("embedded resource selects are refused", async (t) => {
    if (unavailable(t)) return;
    // select() validates eagerly, so this throws at call time rather than
    // resolving to an error result — either way it cannot reach Postgres.
    await withRls(USER_A, async (db) => {
      assert.throws(
        () => asSupabase(db).from("contacts").select("id, organizations!inner(name)"),
        /embedded resource selects/,
      );
    });
  });

  test("count/head queries are refused, not silently miscounted", async (t) => {
    if (unavailable(t)) return;
    // A count returns the wrong shape (rows vs a number), the one unsupported
    // call that could pass quietly — so it must throw like the operators above.
    await withRls(USER_A, async (db) => {
      assert.throws(
        () => asSupabase(db).from("contacts").select("id", { count: "exact", head: true }),
        /count\/head queries are not supported/,
      );
    });
  });

  test("a malicious column reference is rejected, not interpolated", async (t) => {
    if (unavailable(t)) return;
    const res = await withRls(USER_A, async (db) => {
      return asSupabase(db).from("contacts").select("id").eq('id"; drop table contacts; --', 1);
    });
    assert.match(res.error?.message ?? "", /unsafe or unsupported column/);
  });
});
