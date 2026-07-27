import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeEmailIdentity,
  mergeLinkedinIdentity,
  type IdentityRowLike,
  type IdentitySource,
  type SecretsLike,
} from "./identity-merge";
import type { EmailIdentity, LinkedinIdentity } from "./identity-env";

// The matrix this file pins down is exactly where a regression would leak the
// operator's credentials into another tenant's sends, or pair a username with
// a password set for a different account.

const row = (over: Partial<IdentityRowLike>): IdentityRowLike => ({
  id: "row-1",
  user_id: null,
  from_name: null,
  from_email: null,
  smtp_host: null,
  smtp_port: null,
  smtp_user: null,
  imap_host: null,
  imap_port: null,
  imap_user: null,
  heyreach_account_id: null,
  heyreach_campaign_id: null,
  ...over,
});

const secrets = (over: Partial<SecretsLike> = {}): SecretsLike => ({
  smtp_pass: null,
  imap_pass: null,
  heyreach_api_key: null,
  ...over,
});

const src = (r: Partial<IdentityRowLike>, s: Partial<SecretsLike> = {}): IdentitySource => ({
  row: row(r),
  secrets: secrets(s),
});

const envEmail: EmailIdentity = {
  identityId: null,
  fromName: "Operator",
  fromEmail: "op@cohesium.co",
  smtpHost: "smtp.cohesium.co",
  smtpPort: 465,
  smtpUser: "op@cohesium.co",
  smtpPass: "env-smtp-pass",
  imapHost: "imap.cohesium.co",
  imapPort: 993,
  imapUser: "op@cohesium.co",
  imapPass: "env-imap-pass",
  source: "env",
};

const envLinkedin: LinkedinIdentity = {
  identityId: null,
  accountId: "env-account",
  campaignId: "env-campaign",
  apiKey: "env-key",
  source: "env",
};

test("no rows, env allowed: the operator gets exactly the env identity", () => {
  const got = mergeEmailIdentity({ personal: null, shared: null, env: envEmail });
  assert.equal(got.smtpPass, "env-smtp-pass");
  assert.equal(got.source, "env");
});

test("no rows, env forbidden: a tenant gets an empty identity, never env credentials", () => {
  const got = mergeEmailIdentity({ personal: null, shared: null, env: null });
  assert.equal(got.source, "none");
  assert.equal(got.smtpHost, null);
  assert.equal(got.smtpUser, null);
  assert.equal(got.smtpPass, null);
  assert.equal(got.imapPass, null);
});

test("tenant row with missing fields, env forbidden: gaps stay empty instead of borrowing env", () => {
  const got = mergeEmailIdentity({
    personal: null,
    shared: src({ from_email: "b@tenant.io", smtp_host: "smtp.tenant.io" }),
    env: null,
  });
  assert.equal(got.smtpHost, "smtp.tenant.io");
  assert.equal(got.smtpUser, null); // NOT the operator's env user
  assert.equal(got.smtpPass, null);
  assert.equal(got.imapHost, null);
});

test("operator row with missing fields, env allowed: env fills the gaps (pre-036 behavior)", () => {
  const got = mergeEmailIdentity({
    personal: null,
    shared: src({ from_email: "sales@cohesium.co" }),
    env: envEmail,
  });
  assert.equal(got.fromEmail, "sales@cohesium.co");
  assert.equal(got.smtpHost, "smtp.cohesium.co");
  assert.equal(got.smtpUser, "op@cohesium.co");
  assert.equal(got.smtpPass, "env-smtp-pass");
});

test("credential pairing: a row naming its own smtp_user never borrows the env password", () => {
  const got = mergeEmailIdentity({
    personal: null,
    shared: src({ smtp_host: "smtp.x.io", smtp_user: "me@x.io" }), // no stored pass
    env: envEmail,
  });
  assert.equal(got.smtpUser, "me@x.io");
  assert.equal(got.smtpPass, null); // incomplete — held, not mixed
});

test("personal row falls back to the workspace's shared row before the environment", () => {
  const got = mergeEmailIdentity({
    personal: src({ id: "p", user_id: "u1", from_email: "me@tenant.io" }),
    shared: src(
      { id: "s", smtp_host: "smtp.tenant.io", smtp_user: "shared@tenant.io" },
      { smtp_pass: "shared-pass" },
    ),
    env: envEmail,
  });
  assert.equal(got.identityId, "p");
  assert.equal(got.source, "user");
  assert.equal(got.fromEmail, "me@tenant.io");
  assert.equal(got.smtpHost, "smtp.tenant.io"); // shared, not env
  assert.equal(got.smtpUser, "shared@tenant.io");
  assert.equal(got.smtpPass, "shared-pass"); // pass travels with its user
});

test("personal credentials shadow shared ones as a pair, not field by field", () => {
  const got = mergeEmailIdentity({
    personal: src({ id: "p", user_id: "u1", smtp_user: "me@tenant.io" }), // own user, no pass
    shared: src({ id: "s", smtp_user: "shared@tenant.io" }, { smtp_pass: "shared-pass" }),
    env: null,
  });
  assert.equal(got.smtpUser, "me@tenant.io");
  assert.equal(got.smtpPass, null); // never shared-pass under a different user
});

test("imap pairs independently of smtp", () => {
  const got = mergeEmailIdentity({
    personal: null,
    shared: src(
      { smtp_user: "a@x.io", imap_user: "b@x.io" },
      { smtp_pass: "sp", imap_pass: "ip" },
    ),
    env: null,
  });
  assert.equal(got.smtpPass, "sp");
  assert.equal(got.imapPass, "ip");
});

test("linkedin: no rows and env forbidden yields nothing", () => {
  const got = mergeLinkedinIdentity({ personal: null, shared: null, env: null });
  assert.equal(got.source, "none");
  assert.equal(got.apiKey, null);
  assert.equal(got.campaignId, null);
});

test("linkedin: tenant row gaps do not reach the env campaign or key", () => {
  const got = mergeLinkedinIdentity({
    personal: null,
    shared: src({ heyreach_account_id: "tenant-account" }),
    env: null,
  });
  assert.equal(got.accountId, "tenant-account");
  assert.equal(got.campaignId, null); // NOT env-campaign
  assert.equal(got.apiKey, null); // NOT env-key
});

test("linkedin: personal blank campaign uses the workspace's shared campaign", () => {
  const got = mergeLinkedinIdentity({
    personal: src({ id: "p", user_id: "u1", heyreach_account_id: "my-account" }),
    shared: src({ id: "s", heyreach_campaign_id: "firm-campaign" }, { heyreach_api_key: "firm-key" }),
    env: envLinkedin,
  });
  assert.equal(got.accountId, "my-account");
  assert.equal(got.campaignId, "firm-campaign"); // shared beats env
  assert.equal(got.apiKey, "firm-key");
});

test("linkedin: the account never falls back, even within the workspace", () => {
  const got = mergeLinkedinIdentity({
    personal: src({ id: "p", user_id: "u1" }), // personal row, no account
    shared: src({ id: "s", heyreach_account_id: "shared-account" }),
    env: envLinkedin,
  });
  // Pushing this person's leads out of the shared account (or env account)
  // must not happen implicitly.
  assert.equal(got.accountId, null);
});

test("linkedin: a personal row's campaign and key are IGNORED — firm-level only", () => {
  // A personal identity follows its owner across workspaces (043). If its
  // campaign or org API key resolved, one firm's leads would be pushed into
  // another firm's HeyReach campaign the moment the owner switched workspaces.
  const got = mergeLinkedinIdentity({
    personal: src(
      { id: "p", user_id: "u1", heyreach_account_id: "my-seat", heyreach_campaign_id: "stale-campaign" },
      { heyreach_api_key: "stale-key" },
    ),
    shared: src({ id: "s", heyreach_campaign_id: "firm-campaign" }, { heyreach_api_key: "firm-key" }),
    env: envLinkedin,
  });
  assert.equal(got.accountId, "my-seat"); // the seat IS personal and travels
  assert.equal(got.campaignId, "firm-campaign"); // never stale-campaign
  assert.equal(got.apiKey, "firm-key"); // never stale-key
});

test("linkedin: personal row with no shared row and env forbidden gets no campaign or key", () => {
  const got = mergeLinkedinIdentity({
    personal: src(
      { id: "p", user_id: "u1", heyreach_account_id: "my-seat", heyreach_campaign_id: "x" },
      { heyreach_api_key: "y" },
    ),
    shared: null,
    env: null,
  });
  assert.equal(got.accountId, "my-seat");
  assert.equal(got.campaignId, null);
  assert.equal(got.apiKey, null);
});

test("operator linkedin row, env allowed: env fills campaign and key (pre-036 behavior)", () => {
  const got = mergeLinkedinIdentity({
    personal: null,
    shared: src({ heyreach_account_id: "op-account" }),
    env: envLinkedin,
  });
  assert.equal(got.campaignId, "env-campaign");
  assert.equal(got.apiKey, "env-key");
});
