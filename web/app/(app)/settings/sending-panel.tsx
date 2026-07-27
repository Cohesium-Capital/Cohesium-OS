"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail, Share2, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  saveSendingIdentity,
  deleteSendingIdentity,
  type SendingIdentityRow,
} from "@/lib/workspace/admin-actions";

// Who this workspace's mail and LinkedIn requests come from.
//
// Credentials are write-only here by construction: the server cannot read them
// back to show you, so a password field is always blank and always means
// "replace it" when filled and "leave it alone" when not. That is deliberate —
// a page that could display an SMTP password would be a page that could leak
// one.

export type MemberOption = { userId: string; email: string | null };

const EMPTY = {
  id: undefined as string | undefined,
  channel: "email" as "email" | "linkedin",
  userId: null as string | null,
  fromName: "",
  fromEmail: "",
  smtpHost: "",
  smtpPort: "",
  smtpUser: "",
  smtpPass: "",
  imapHost: "",
  imapPort: "",
  imapUser: "",
  imapPass: "",
  heyreachAccountId: "",
  heyreachCampaignId: "",
  heyreachApiKey: "",
};

export function SendingPanel({
  identities,
  members,
  isAdmin,
  currentUserId,
  envConfigured,
}: {
  identities: SendingIdentityRow[];
  members: MemberOption[];
  isAdmin: boolean;
  currentUserId: string;
  envConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<typeof EMPTY | null>(null);

  const set = (k: keyof typeof EMPTY, v: string | null) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        toast.success(ok);
        setForm(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  const emailFor = (userId: string | null) =>
    userId ? members.find((m) => m.userId === userId)?.email ?? "a member" : "everyone";

  // A personal identity is managed by its owner alone (it follows them across
  // workspaces); the shared identity by workspace admins.
  const canManage = (i: SendingIdentityRow) =>
    i.userId ? i.userId === currentUserId : isAdmin;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Sending</CardTitle>
        <CardDescription>
          Which mailbox and LinkedIn account outreach goes out from. Your personal identity is
          yours — it follows you into every workspace you belong to, and only you can edit it.
          The shared identity is this workspace&rsquo;s own and covers anyone without their own;
          campaign and API key are set there, since those belong to the firm.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {identities.length === 0 && (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            {envConfigured ? (
              <>
                Nothing configured here, so this workspace uses the mailbox and HeyReach account
                set in the deployment&rsquo;s environment variables — exactly as it did before
                identities existed. Add one below only when you want this workspace to send as
                someone else.
              </>
            ) : (
              <>
                No sending identity, and the environment has none either. Drafts will queue and
                stay queued until one is configured.
              </>
            )}
          </p>
        )}

        {identities.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
            {i.channel === "email" ? <Mail className="size-4" /> : <Share2 className="size-4" />}
            <span className="font-medium">
              {i.channel === "email"
                ? i.fromEmail ?? "(no From address)"
                : i.heyreachAccountId ?? "(no account)"}
            </span>
            <Badge variant={i.userId ? "default" : "secondary"}>{emailFor(i.userId)}</Badge>
            {i.channel === "email" && (
              <Badge variant={i.hasSmtpPass ? "outline" : "destructive"}>
                {i.hasSmtpPass ? "password set" : "no password"}
              </Badge>
            )}
            {i.channel === "linkedin" && (
              <Badge variant={i.hasHeyreachKey ? "outline" : "secondary"}>
                {i.hasHeyreachKey ? "key set" : "using env key"}
              </Badge>
            )}
            {canManage(i) && (
              <div className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    setForm({
                      ...EMPTY,
                      id: i.id,
                      channel: i.channel,
                      userId: i.userId,
                      fromName: i.fromName ?? "",
                      fromEmail: i.fromEmail ?? "",
                      smtpHost: i.smtpHost ?? "",
                      smtpPort: i.smtpPort ? String(i.smtpPort) : "",
                      smtpUser: i.smtpUser ?? "",
                      imapHost: i.imapHost ?? "",
                      imapPort: i.imapPort ? String(i.imapPort) : "",
                      imapUser: i.imapUser ?? "",
                      heyreachAccountId: i.heyreachAccountId ?? "",
                      heyreachCampaignId: i.heyreachCampaignId ?? "",
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => deleteSendingIdentity(i.id), "Removed.")}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}

        {!form && (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                // Non-admins can only add their own personal identity, so the
                // form opens pre-scoped to them.
                setForm({ ...EMPTY, userId: isAdmin ? null : currentUserId })
              }
            >
              <Plus className="size-3.5" /> Add a sending identity
            </Button>
          </div>
        )}

        {form && (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex flex-wrap gap-2">
              <select
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={form.channel}
                onChange={(e) => set("channel", e.target.value)}
                disabled={pending || !!form.id}
              >
                <option value="email">Email</option>
                <option value="linkedin">LinkedIn</option>
              </select>
              <select
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={form.userId ?? ""}
                onChange={(e) => set("userId", e.target.value || null)}
                disabled={pending || !!form.id || !isAdmin}
              >
                {isAdmin && <option value="">Shared — anyone without their own</option>}
                <option value={currentUserId}>
                  You — follows you across your workspaces
                </option>
              </select>
            </div>

            {form.channel === "email" ? (
              <div className="grid gap-2 md:grid-cols-2">
                <Field label="From name" value={form.fromName} onChange={(v) => set("fromName", v)} placeholder="Ripley" />
                <Field label="From address" value={form.fromEmail} onChange={(v) => set("fromEmail", v)} placeholder="you@firm.com" />
                <Field label="SMTP host" value={form.smtpHost} onChange={(v) => set("smtpHost", v)} placeholder="leave blank to use the shared host" />
                <Field label="SMTP port" value={form.smtpPort} onChange={(v) => set("smtpPort", v)} placeholder="465" />
                <Field label="SMTP user" value={form.smtpUser} onChange={(v) => set("smtpUser", v)} placeholder="you@firm.com" />
                <Field
                  label="SMTP password"
                  value={form.smtpPass}
                  onChange={(v) => set("smtpPass", v)}
                  placeholder={form.id ? "unchanged" : "required to send"}
                  type="password"
                />
                <Field label="IMAP host" value={form.imapHost} onChange={(v) => set("imapHost", v)} placeholder="for reply capture" />
                <Field label="IMAP user" value={form.imapUser} onChange={(v) => set("imapUser", v)} placeholder="you@firm.com" />
                <Field
                  label="IMAP password"
                  value={form.imapPass}
                  onChange={(v) => set("imapPass", v)}
                  placeholder={form.id ? "unchanged" : ""}
                  type="password"
                />
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                <Field
                  label="HeyReach account id"
                  value={form.heyreachAccountId}
                  onChange={(v) => set("heyreachAccountId", v)}
                  placeholder="the LinkedIn account to send from"
                />
                {form.userId ? (
                  <p className="self-end text-xs text-muted-foreground">
                    Campaign and API key belong to the firm, so they come from the
                    workspace&rsquo;s shared identity — your account rides whichever
                    workspace you send from.
                  </p>
                ) : (
                  <>
                    <Field
                      label="Campaign id"
                      value={form.heyreachCampaignId}
                      onChange={(v) => set("heyreachCampaignId", v)}
                      placeholder="this workspace's campaign"
                    />
                    <Field
                      label="API key"
                      value={form.heyreachApiKey}
                      onChange={(v) => set("heyreachApiKey", v)}
                      placeholder={form.id ? "unchanged" : "blank uses the env key"}
                      type="password"
                    />
                  </>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      saveSendingIdentity({
                        id: form.id,
                        channel: form.channel,
                        userId: form.userId,
                        fromName: form.fromName,
                        fromEmail: form.fromEmail,
                        smtpHost: form.smtpHost,
                        smtpPort: form.smtpPort ? Number(form.smtpPort) : null,
                        smtpUser: form.smtpUser,
                        smtpPass: form.smtpPass,
                        imapHost: form.imapHost,
                        imapPort: form.imapPort ? Number(form.imapPort) : null,
                        imapUser: form.imapUser,
                        imapPass: form.imapPass,
                        heyreachAccountId: form.heyreachAccountId,
                        heyreachCampaignId: form.heyreachCampaignId,
                        heyreachApiKey: form.heyreachApiKey,
                      }),
                    "Saved.",
                  )
                }
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setForm(null)}>
                Cancel
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                Passwords are stored where no browser session can read them back, so these fields
                are always blank. Filling one replaces the stored value; leaving it blank keeps
                what is already there.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        value={value}
        type={type}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
    </label>
  );
}
