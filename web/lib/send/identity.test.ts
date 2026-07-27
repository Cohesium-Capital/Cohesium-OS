import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { envEmailIdentity, envLinkedinIdentity, fromHeader, emailIdentityReady } from "./identity-env";

// The property that makes migration 036 invisible to Cohesium: with no identity
// row configured, everything resolves to exactly the environment variables the
// sender used before identities existed.

const KEYS = [
  "MAIL_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASS",
  "HEYREACH_API_KEY",
  "HEYREACH_ACCOUNT_ID",
  "HEYREACH_CAMPAIGN_ID",
] as const;

const saved: Record<string, string | undefined> = {};
function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("sending identity", () => {
  test('MAIL_FROM in "Name <address>" form splits into name and address', () => {
    setEnv({ MAIL_FROM: "Ripley <ripley@cohesium.co>" });
    const i = envEmailIdentity();
    assert.equal(i.fromName, "Ripley");
    assert.equal(i.fromEmail, "ripley@cohesium.co");
    // Round-trips: what goes on the wire is what was configured.
    assert.equal(fromHeader(i), "Ripley <ripley@cohesium.co>");
  });

  test("a bare address is still a valid From", () => {
    setEnv({ MAIL_FROM: "ripley@cohesium.co" });
    const i = envEmailIdentity();
    assert.equal(i.fromName, null);
    assert.equal(i.fromEmail, "ripley@cohesium.co");
    assert.equal(fromHeader(i), "ripley@cohesium.co");
  });

  test("the port defaults to 465 and is read as a number", () => {
    setEnv({ SMTP_HOST: "smtp.example.com" });
    assert.equal(envEmailIdentity().smtpPort, 465);
    setEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587" });
    const i = envEmailIdentity();
    assert.equal(i.smtpPort, 587);
    assert.equal(typeof i.smtpPort, "number", "a string port would break TLS selection");
  });

  test("readiness names the missing piece rather than failing vaguely", () => {
    setEnv({});
    assert.equal(emailIdentityReady(envEmailIdentity()), "no SMTP host");
    setEnv({ SMTP_HOST: "h" });
    assert.equal(emailIdentityReady(envEmailIdentity()), "no SMTP user");
    setEnv({ SMTP_HOST: "h", SMTP_USER: "u" });
    assert.equal(emailIdentityReady(envEmailIdentity()), "no SMTP password");
    setEnv({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" });
    assert.equal(emailIdentityReady(envEmailIdentity()), "no From address");
    setEnv({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p", MAIL_FROM: "a@b.co" });
    assert.equal(emailIdentityReady(envEmailIdentity()), null, "fully configured is ready");
  });

  test("a fully configured environment resolves to exactly those values", () => {
    // Cohesium's shape. Nothing here may be transformed on the way through.
    setEnv({
      MAIL_FROM: "Ripley <ripley@cohesium.co>",
      SMTP_HOST: "smtp.hostinger.com",
      SMTP_PORT: "465",
      SMTP_USER: "ripley@cohesium.co",
      SMTP_PASS: "secret",
      IMAP_HOST: "imap.hostinger.com",
      IMAP_USER: "ripley@cohesium.co",
      IMAP_PASS: "secret",
    });
    const i = envEmailIdentity();
    assert.deepEqual(
      {
        from: fromHeader(i),
        host: i.smtpHost,
        port: i.smtpPort,
        user: i.smtpUser,
        pass: i.smtpPass,
        imapHost: i.imapHost,
        imapPort: i.imapPort,
      },
      {
        from: "Ripley <ripley@cohesium.co>",
        host: "smtp.hostinger.com",
        port: 465,
        user: "ripley@cohesium.co",
        pass: "secret",
        imapHost: "imap.hostinger.com",
        imapPort: 993,
      },
    );
    assert.equal(i.source, "env");
  });

  test("the LinkedIn identity comes through unchanged too", () => {
    setEnv({
      HEYREACH_API_KEY: "k",
      HEYREACH_ACCOUNT_ID: "12345",
      HEYREACH_CAMPAIGN_ID: "678",
    });
    assert.deepEqual(envLinkedinIdentity(), {
      identityId: null,
      apiKey: "k",
      accountId: "12345",
      campaignId: "678",
      source: "env",
    });
  });
});
