"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requestAccess, type AccessRequest } from "@/lib/access/actions";

// What a signed-in stranger sees.
//
// This replaces a dead end: before, an account not on the environment's
// allowlist got a "No access" card and a Sign out button, and nobody was told
// they had tried. Being signed in without a workspace is not an error state —
// it is the beginning of onboarding.
//
// They can see nothing either way. Every table is gated on workspace membership,
// so an account without one reads zero rows regardless of what this page does.

export function RequestAccess({
  email,
  existing,
  signOut,
}: {
  email: string | null;
  existing: AccessRequest | null;
  signOut: () => Promise<void>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fullName, setFullName] = useState(existing?.fullName ?? "");
  const [firmName, setFirmName] = useState(existing?.firmName ?? "");
  const [note, setNote] = useState(existing?.note ?? "");

  const submit = () =>
    start(async () => {
      try {
        await requestAccess({ fullName, firmName, note });
        toast.success("Request sent.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  if (existing?.status === "denied") {
    return (
      <Shell title="Not approved" signOut={signOut}>
        <CardDescription>
          This account was not approved for access.
          {existing.decisionNote ? ` ${existing.decisionNote}` : ""}
        </CardDescription>
      </Shell>
    );
  }

  if (existing?.status === "pending") {
    return (
      <Shell title="Request received" signOut={signOut}>
        <CardDescription>
          Thanks — {email} is waiting on approval. You&rsquo;ll get an email once your
          workspace is ready. You can update the details below while you wait.
        </CardDescription>
        <Form
          fullName={fullName}
          firmName={firmName}
          note={note}
          setFullName={setFullName}
          setFirmName={setFirmName}
          setNote={setNote}
          pending={pending}
          onSubmit={submit}
          submitLabel="Update my request"
        />
      </Shell>
    );
  }

  return (
    <Shell title="Request access" signOut={signOut}>
      <CardDescription>
        You&rsquo;re signed in as {email}, but this account isn&rsquo;t part of a workspace
        yet. Tell us who you are and we&rsquo;ll set one up for your firm.
      </CardDescription>
      <Form
        fullName={fullName}
        firmName={firmName}
        note={note}
        setFullName={setFullName}
        setFirmName={setFirmName}
        setNote={setNote}
        pending={pending}
        onSubmit={submit}
        submitLabel="Request access"
      />
    </Shell>
  );
}

function Form({
  fullName,
  firmName,
  note,
  setFullName,
  setFirmName,
  setNote,
  pending,
  onSubmit,
  submitLabel,
}: {
  fullName: string;
  firmName: string;
  note: string;
  setFullName: (v: string) => void;
  setFirmName: (v: string) => void;
  setNote: (v: string) => void;
  pending: boolean;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Your name</span>
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={pending} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Your firm</span>
        <Input
          value={firmName}
          onChange={(e) => setFirmName(e.target.value)}
          placeholder="Used to name your workspace"
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Anything else (optional)</span>
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What market you're researching, who referred you…"
          disabled={pending}
        />
      </label>
      <div>
        <Button onClick={onSubmit} disabled={pending || !fullName.trim() || !firmName.trim()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function Shell({
  title,
  children,
  signOut,
}: {
  title: string;
  children: React.ReactNode;
  signOut: () => Promise<void>;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {children}
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
