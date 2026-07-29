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
import { saveMemberSender } from "@/lib/settings/actions";

// How YOU sign the outreach you send from this workspace.
//
// The sign-off and intro follow the person, not the firm: whoever is logged in
// signs as themselves. This panel is where you set your own — distinct from the
// firm default an admin sets in "How this firm talks". Leave a box blank and the
// placeholder shows what you'll sign as instead (your name, or the firm default).

export function SenderPanel({
  initialName,
  initialIntro,
  initialApproach,
  placeholderName,
  placeholderIntro,
  placeholderApproach,
}: {
  initialName: string;
  initialIntro: string;
  initialApproach: string;
  placeholderName: string;
  placeholderIntro: string;
  placeholderApproach: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(initialName);
  const [intro, setIntro] = useState(initialIntro);
  const [approach, setApproach] = useState(initialApproach);

  const dirty =
    name !== initialName || intro !== initialIntro || approach !== initialApproach;

  const save = () =>
    start(async () => {
      try {
        await saveMemberSender({ senderName: name, senderIntro: intro, approach });
        toast.success("Saved. New drafts you create sign as this.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Something went wrong.");
      }
    });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Your sign-off</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">You, within this workspace.</span> How
          messages <em>you</em> draft here are signed and framed — teammates sign as themselves,
          and this does not follow you to other workspaces. Leave a box blank to use the
          placeholder (your firm&rsquo;s default, or your name). Your mailbox itself lives under
          Sending and follows you across every workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Sign-off name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholderName}
            disabled={pending}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            Intro — one honest line of &ldquo;who I am&rdquo;, used verbatim in drafts
          </span>
          <Textarea
            rows={3}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            placeholder={placeholderIntro}
            disabled={pending}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            Why you&rsquo;re reaching out — one honest sentence
          </span>
          <Textarea
            rows={2}
            value={approach}
            onChange={(e) => setApproach(e.target.value)}
            placeholder={placeholderApproach}
            disabled={pending}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending || !dirty} onClick={save}>
            Save
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setName(initialName);
                setIntro(initialIntro);
                setApproach(initialApproach);
              }}
            >
              Discard changes
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
