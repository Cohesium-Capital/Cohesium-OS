"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, UserPlus, X, RotateCcw, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  createWorkspace,
  renameWorkspace,
  inviteMember,
  withdrawInvite,
  changeMemberRole,
  removeMember,
  saveWorkspaceProfile,
  resetWorkspaceProfile,
} from "@/lib/workspace/admin-actions";
import { formatDate } from "@/lib/format/date";

// Workspace administration: who is in the firm, and how the firm talks.
//
// The identity fields below are not cosmetic — they are rendered verbatim into
// every outbound message and every research prompt. So each field shows the
// value that will actually be used, with the built-in default as its
// placeholder, and leaving one blank means "keep using the default" rather than
// "make it empty".

export type MemberRow = {
  userId: string;
  email: string | null;
  role: string;
  isYou: boolean;
};

export type InviteRow = { id: string; email: string; role: string; createdAt: string };

export type ProfileFields = {
  firmName: string;
  senderIntro: string;
  approach: string;
  vocab: Record<string, string>;
};

// 'partner' is not offered: since 028 the data policies check membership
// only, so a partner would silently get full member access. Existing partner
// rows still display and can be moved to a real role here.
const ROLES = ["admin", "member"] as const;
type Role = (typeof ROLES)[number];

const VOCAB_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "providerSingular", label: "Target company (singular)", hint: "managed IT service provider" },
  { key: "providerPlural", label: "Target company (plural)", hint: "managed IT service providers" },
  { key: "providerAbbrev", label: "Short form", hint: "MSP" },
  { key: "providerAbbrevPlural", label: "Short form (plural)", hint: "MSPs" },
  { key: "providerGeneric", label: "How a customer refers to theirs", hint: "managed IT provider" },
  { key: "market", label: "The market", hint: "managed IT market" },
  { key: "marketShort", label: "The market (short)", hint: "managed IT" },
];

export function WorkspacePanel({
  workspaceName,
  isAdmin,
  members,
  invites,
  profile,
  defaults,
  hasOverrides,
}: {
  workspaceName: string;
  isAdmin: boolean;
  members: MemberRow[];
  invites: InviteRow[];
  profile: ProfileFields;
  defaults: ProfileFields;
  hasOverrides: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [name, setName] = useState(workspaceName);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [newWorkspace, setNewWorkspace] = useState("");
  const [fields, setFields] = useState(profile);

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  const setVocab = (key: string, value: string) =>
    setFields((f) => ({ ...f, vocab: { ...f.vocab, [key]: value } }));

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" /> Workspace
          </CardTitle>
          <CardDescription>
            A workspace is one firm: its own companies, contacts, prompts and learned rules.
            Nothing is shared between workspaces, and switching between them changes everything
            on screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isAdmin || pending}
                className="w-64"
              />
            </label>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !name.trim() || name === workspaceName}
                onClick={() => run(() => renameWorkspace(name), "Workspace renamed.")}
              >
                Rename
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-2 border-t pt-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Start another workspace</span>
              <Input
                value={newWorkspace}
                onChange={(e) => setNewWorkspace(e.target.value)}
                placeholder="Second firm's name"
                disabled={pending}
                className="w-64"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !newWorkspace.trim()}
              onClick={() =>
                run(async () => {
                  await createWorkspace(newWorkspace);
                  setNewWorkspace("");
                }, "Workspace created — switch to it from the header.")
              }
            >
              <Plus className="size-3.5" /> Create
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              You become its admin. It starts completely empty — no companies, no contacts, and
              the default prompts.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">People</CardTitle>
          <CardDescription>
            Everyone here can see and change all of this workspace&rsquo;s data. Admins can also
            rename it, invite others, and change roles.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            {members.map((m) => (
              <div
                key={m.userId}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="font-medium">{m.email ?? m.userId.slice(0, 8)}</span>
                {m.isYou && <span className="text-xs text-muted-foreground">(you)</span>}
                <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role}</Badge>
                {isAdmin && (
                  <div className="ml-auto flex items-center gap-1">
                    {ROLES.filter((r) => r !== m.role).map((r) => (
                      <Button
                        key={r}
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          run(() => changeMemberRole(m.userId, r), `Now a ${r}.`)
                        }
                      >
                        Make {r}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => removeMember(m.userId),
                          m.isYou ? "You left the workspace." : "Removed.",
                        )
                      }
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {invites.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                Invited, waiting for them to sign in with that address:
              </p>
              {invites.map((i) => (
                <div
                  key={i.id}
                  className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
                >
                  <span>{i.email}</span>
                  <Badge variant="outline">{i.role}</Badge>
                  <span className="text-xs text-muted-foreground">
                    invited {formatDate(i.createdAt)}
                  </span>
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      disabled={pending}
                      onClick={() => run(() => withdrawInvite(i.id), "Invite withdrawn.")}
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {isAdmin && (
            <div className="flex flex-wrap items-end gap-2 border-t pt-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Invite by email</span>
                <Input
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@firm.com"
                  disabled={pending}
                  className="w-64"
                />
              </label>
              <select
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as Role)}
                disabled={pending}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !inviteEmail.trim()}
                onClick={() =>
                  run(async () => {
                    await inviteMember(inviteEmail, inviteRole);
                    setInviteEmail("");
                  }, "Invited.")
                }
              >
                <UserPlus className="size-3.5" /> Invite
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                The invite is claimed automatically the next time they sign in with that exact
                address. It grants nothing until then.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How this firm talks</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">Tenant-wide.</span> Set by an admin,
            applies to everyone in this workspace. These go into every research prompt and every
            drafted message. Leave a field blank to keep the built-in default (shown as the
            placeholder). The intro and approach here are the firm <em>defaults</em> — each member
            can override their own in &ldquo;Your sign-off&rdquo; below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Firm name</span>
            <Input
              value={fields.firmName}
              placeholder={defaults.firmName}
              onChange={(e) => setFields((f) => ({ ...f, firmName: e.target.value }))}
              disabled={!isAdmin || pending}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              One line of who you are — the firm default (members can override)
            </span>
            <Input
              value={fields.senderIntro}
              placeholder={defaults.senderIntro}
              onChange={(e) => setFields((f) => ({ ...f, senderIntro: e.target.value }))}
              disabled={!isAdmin || pending}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              Why you&rsquo;re reaching out — the firm default (members can override)
            </span>
            <Textarea
              rows={2}
              value={fields.approach}
              placeholder={defaults.approach}
              onChange={(e) => setFields((f) => ({ ...f, approach: e.target.value }))}
              disabled={!isAdmin || pending}
            />
          </label>

          <div className="border-t pt-4">
            <p className="mb-1 text-sm font-medium">What you call the market</p>
            <p className="mb-3 text-xs text-muted-foreground">
              Tenant-wide, for now. Substituted throughout the sourcing and drafting prompts. A firm
              researching staffing agencies rather than IT providers changes these and the prompts
              follow.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {VOCAB_FIELDS.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{f.label}</span>
                  <Input
                    value={fields.vocab[f.key] ?? ""}
                    placeholder={f.hint}
                    onChange={(e) => setVocab(f.key, e.target.value)}
                    disabled={!isAdmin || pending}
                  />
                </label>
              ))}
            </div>
          </div>

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      saveWorkspaceProfile({
                        firmName: fields.firmName,
                        senderIntro: fields.senderIntro,
                        approach: fields.approach,
                        vocab: fields.vocab,
                      }),
                    "Saved. New runs use this; drafts already written are unchanged.",
                  )
                }
              >
                Save
              </Button>
              {hasOverrides && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      await resetWorkspaceProfile();
                      setFields(defaults);
                    }, "Back to the defaults.")
                  }
                >
                  <RotateCcw className="size-3.5" /> Reset to defaults
                </Button>
              )}
              <p className="w-full text-xs text-muted-foreground">
                Changing these changes the prompt, so the next run registers a new prompt version
                — error rates stay comparable within a version rather than silently spanning two
                different prompts.
              </p>
            </div>
          )}

          {!isAdmin && (
            <p className="text-xs text-muted-foreground">
              Only an admin of this workspace can change these.
            </p>
          )}

          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Worked examples are not on this page.</strong>{" "}
            The drafting prompt also carries gold-standard example messages and persona angles
            written for this market specifically. Vocabulary substitution cannot sensibly rewrite
            those, so a firm in a different market should replace them wholesale — they live in{" "}
            <code>workspace_profile.copy</code> and are not yet editable here.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
