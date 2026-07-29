import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSenderOverrides, applySenderOverrides, type SenderSources } from "./sender";
import { DEFAULT_PROFILE } from "./identity";

// The precedence this pins down is what makes "the sign-off follows the logged-in
// user" true: an explicit override wins, else a first name derived from the
// user's sending identity, else their profile name; and the intro comes ONLY
// from an explicit override — a name source never invents prose.

const sources = (over: Partial<SenderSources> = {}): SenderSources => ({
  override: null,
  identityFromName: null,
  fullName: null,
  ...over,
});

test("explicit override is used verbatim, not first-named", () => {
  const out = pickSenderOverrides(
    sources({
      override: {
        sender_name: "Saagar K.",
        sender_intro: "I'm a cofounder of Ilium",
        approach: "We're modernizing retirement TPA and talk with the people who run these firms",
      },
    }),
  );
  assert.deepEqual(out, {
    senderName: "Saagar K.",
    senderIntro: "I'm a cofounder of Ilium",
    approach: "We're modernizing retirement TPA and talk with the people who run these firms",
  });
});

test("sending-identity name falls back to a first name", () => {
  const out = pickSenderOverrides(sources({ identityFromName: "Saagar Kulkarni" }));
  assert.deepEqual(out, { senderName: "Saagar" });
});

test("profile full_name is the last name source, first-named", () => {
  const out = pickSenderOverrides(sources({ fullName: "Ripley Carroll" }));
  assert.deepEqual(out, { senderName: "Ripley" });
});

test("name precedence: override > identity > profile", () => {
  const out = pickSenderOverrides(
    sources({
      override: { sender_name: "Sam", sender_intro: null, approach: null },
      identityFromName: "Ignored Identity",
      fullName: "Ignored Profile",
    }),
  );
  assert.equal(out.senderName, "Sam");
});

test("intro comes only from an explicit override", () => {
  // A name source must never supply an intro line.
  const out = pickSenderOverrides(sources({ identityFromName: "Saagar Kulkarni" }));
  assert.equal(out.senderIntro, undefined);
});

test("blank/whitespace values are ignored and fall through", () => {
  const out = pickSenderOverrides(
    sources({
      override: { sender_name: "   ", sender_intro: "", approach: "  " },
      fullName: "Ripley Carroll",
    }),
  );
  assert.deepEqual(out, { senderName: "Ripley" });
});

test("approach comes only from an explicit override (never derived)", () => {
  // A name source supplies no approach; an override does.
  assert.equal(pickSenderOverrides(sources({ fullName: "Ripley Carroll" })).approach, undefined);
  assert.equal(
    pickSenderOverrides(
      sources({ override: { sender_name: null, sender_intro: null, approach: "why we reach out" } }),
    ).approach,
    "why we reach out",
  );
});

test("nothing resolvable yields no keys, so the caller keeps its default", () => {
  assert.deepEqual(pickSenderOverrides(sources()), {});
});

test("applySenderOverrides is a no-op when there is nothing to apply", () => {
  const same = applySenderOverrides(DEFAULT_PROFILE, {});
  assert.equal(same, DEFAULT_PROFILE);
});

test("applySenderOverrides overlays only the provided fields", () => {
  const out = applySenderOverrides(DEFAULT_PROFILE, { senderName: "Saagar" });
  assert.equal(out.senderName, "Saagar");
  // Untouched fields are preserved.
  assert.equal(out.senderIntro, DEFAULT_PROFILE.senderIntro);
  assert.equal(out.firmName, DEFAULT_PROFILE.firmName);
  assert.deepEqual(out.vocab, DEFAULT_PROFILE.vocab);
});
