"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { sendMail } from "@/lib/send/smtp";
import { envEmailIdentity, emailIdentityReady } from "@/lib/send/identity-env";

// Asking for access, and granting it.
//
// The decisions here are enforced in the database (migration 038): a requester
// can write their own row and edit it while pending, but a trigger refuses any
// attempt to move the status, and approval runs through a definer function that
// checks the operator first. The checks in this file exist to produce readable
// errors, not to be the boundary.

export type AccessRequest = {
  id: string;
  userId: string;
  email: string;
  fullName: string | null;
  firmName: string | null;
  note: string | null;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  decisionNote: string | null;
  workspaceId: string | null;
};

/** The signed-in user's own request, if they have made one. */
export async function myAccessRequest(): Promise<AccessRequest | null> {
  const user = await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("access_requests")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  return data ? toRequest(data as Record<string, unknown>) : null;
}

/**
 * Record a request for access and tell the operator about it.
 *
 * The email address is taken from the session, never from the form: it is the
 * one thing here that must be true, since it is what the operator will approve.
 */
export async function requestAccess(input: {
  fullName: string;
  firmName: string;
  note?: string;
}): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();

  const fullName = input.fullName.trim();
  const firmName = input.firmName.trim();
  if (!fullName) throw new Error("Please give your name.");
  if (!firmName) throw new Error("Please give your firm's name.");

  const row = {
    user_id: user.id,
    email: user.email ?? "",
    full_name: fullName,
    firm_name: firmName,
    note: input.note?.trim() || null,
  };

  // Upsert so a second submission edits the pending request rather than
  // failing on the unique user_id — someone correcting a typo should not have
  // to ask an admin to delete their first attempt.
  const { error } = await supabase
    .from("access_requests")
    .upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(error.message);

  await notifyOperator({ ...row, note: row.note });
  revalidatePath("/", "layout");
}

/**
 * Email the operator that someone is waiting.
 *
 * Never throws: the request is already safely recorded and visible in Settings,
 * so a mail failure must not make the requester think their submission failed.
 * It is reported into the row's note instead, so a silent SMTP problem is
 * visible somewhere rather than nowhere.
 */
async function notifyOperator(req: {
  user_id: string;
  email: string;
  full_name: string | null;
  firm_name: string | null;
  note: string | null;
}): Promise<void> {
  const to = process.env.ACCESS_REQUEST_NOTIFY_EMAIL ?? process.env.MAIL_FROM ?? "";
  const address = /<([^>]+)>/.exec(to)?.[1] ?? to;
  // emailIdentityReady returns the MISSING piece, so a non-null value means
  // "not ready" — there is no mailbox to send this from.
  const smtpMissing = emailIdentityReady(envEmailIdentity());
  if (!address || smtpMissing) return;

  const origin = siteOrigin();
  const lines = [
    `${req.full_name ?? req.email} asked for access to Cohesium Intel.`,
    "",
    `Name:  ${req.full_name ?? "(not given)"}`,
    `Email: ${req.email}`,
    `Firm:  ${req.firm_name ?? "(not given)"}`,
    req.note ? `\nWhat they said:\n${req.note}` : "",
    "",
    "Approving creates a new workspace with them as its admin — their own",
    "tenant, with no access to yours.",
    "",
    origin ? `Approve or decline: ${origin}/settings` : "Approve or decline in Settings.",
  ].filter(Boolean);

  try {
    await sendMail({
      to: address,
      subject: `Access request: ${req.full_name ?? req.email}${req.firm_name ? ` (${req.firm_name})` : ""}`,
      text: lines.join("\n"),
      // Instance-level notification TO the operator — the env identity is the
      // operator's own mailbox, so this is the one legitimate direct use.
      identity: envEmailIdentity(),
    });
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}

/**
 * Where this deployment lives, for links in emails.
 *
 * Vercel supplies the production domain, so this needs no configuration.
 * SITE_URL overrides it for a custom domain or a non-Vercel deployment. Not
 * NEXT_PUBLIC_: it is read on the server and never needed in the browser.
 */
function siteOrigin(): string {
  const configured = process.env.SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "";
  if (!configured) return "";
  return configured.startsWith("http") ? configured : `https://${configured}`;
}

/** Every request awaiting a decision. Operator-only by RLS. */
export async function pendingAccessRequests(): Promise<AccessRequest[]> {
  await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("access_requests")
    .select("*")
    .eq("status", "pending")
    .order("created_at");
  return ((data ?? []) as Record<string, unknown>[]).map(toRequest);
}

/**
 * Approve, creating the requester's own workspace with them as admin.
 *
 * `workspaceName` defaults to the firm they gave. The new workspace is empty:
 * no companies, no contacts, and the default prompts, which they then make
 * their own in Settings.
 */
export async function approveAccessRequest(
  requestId: string,
  workspaceName?: string,
): Promise<void> {
  await requireUser();
  const supabase = await createClient();

  // Read the request BEFORE approving: afterwards it is no longer pending, and
  // the requester's address is what the confirmation email needs.
  const { data: before } = await supabase
    .from("access_requests")
    .select("email, full_name")
    .eq("id", requestId)
    .maybeSingle();

  const { error } = await supabase.rpc("approve_access_request", {
    p_request_id: requestId,
    p_workspace_name: workspaceName?.trim() || null,
  });
  if (error) throw new Error(error.message);

  if (before?.email) {
    await notifyApproved(before.email as string, (before.full_name as string | null) ?? null);
  }

  revalidatePath("/settings");
  revalidatePath("/", "layout");
}

/**
 * Tell the requester they are in.
 *
 * The waiting screen promises this, so it has to happen — a promise the system
 * does not keep is worse than no promise. Like the operator notification it
 * never throws: the workspace already exists and the approval already
 * succeeded, so a mail failure must not surface as "approval failed" and tempt
 * a second click.
 */
async function notifyApproved(email: string, fullName: string | null): Promise<void> {
  if (emailIdentityReady(envEmailIdentity())) return;
  const origin = siteOrigin();
  try {
    await sendMail({
      to: email,
      subject: "Your workspace is ready",
      text: [
        `${fullName ? `Hi ${fullName.split(" ")[0]},` : "Hi,"}`,
        "",
        "You've been approved. Your workspace is set up and waiting — sign in with",
        "this address and you'll go straight to it.",
        "",
        "It starts empty. The first thing worth doing is Settings, where you set",
        "your firm's name, how you introduce yourself, and what you call the market",
        "you research — all of it goes into the messages the system drafts for you.",
        "",
        ...(origin ? [`${origin}/settings`] : []),
      ].join("\n"),
      // Sent BY the operator (the approver), announcing the new tenant — the
      // env identity is the operator's mailbox.
      identity: envEmailIdentity(),
    });
  } catch {
    // Deliberately swallowed — see above.
  }
}

export async function denyAccessRequest(requestId: string, reason: string): Promise<void> {
  const user = await requireUser();
  const supabase = await createClient();
  // Only a PENDING request can be denied. Without the guard, declining a
  // request another operator had already approved recorded "denied" while the
  // tenant the approval created lived on — the record and reality disagreed.
  const { data: updated, error } = await supabase
    .from("access_requests")
    .update({
      status: "denied",
      decided_at: new Date().toISOString(),
      decided_by: user.id,
      decision_note: reason.trim() || null,
    })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(error.message);
  if (!updated?.length) {
    throw new Error("This request was already decided (possibly by another operator). Refresh to see its current state.");
  }
  revalidatePath("/settings");
}

/**
 * Is the signed-in user the operator of this deployment?
 *
 * Asked with the service-role client because is_instance_operator() reads the
 * first workspace's membership, which a stranger cannot see — under their own
 * client the answer would always be false rather than merely false-for-them.
 */
export async function isInstanceOperator(): Promise<boolean> {
  const user = await requireUser();
  try {
    // createAdminClient throws outright when SUPABASE_SERVICE_ROLE_KEY is
    // absent, and this is called during the Settings page render — an
    // unguarded throw here would take the whole page down for everyone,
    // including the people who could fix it. Failing closed hides one panel.
    const admin = createAdminClient();
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id")
      .order("created_at")
      .limit(1);
    const first = (workspaces ?? [])[0]?.id as string | undefined;
    if (!first) return false;
    const { data } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", first)
      .eq("user_id", user.id)
      .maybeSingle();
    return (data?.role as string | undefined) === "admin";
  } catch {
    return false;
  }
}

function toRequest(r: Record<string, unknown>): AccessRequest {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    email: r.email as string,
    fullName: (r.full_name as string | null) ?? null,
    firmName: (r.firm_name as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    status: r.status as AccessRequest["status"],
    createdAt: r.created_at as string,
    decisionNote: (r.decision_note as string | null) ?? null,
    workspaceId: (r.workspace_id as string | null) ?? null,
  };
}
