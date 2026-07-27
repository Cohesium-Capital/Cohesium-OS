"use client";

import { useState, useTransition } from "react";
import { Check, ChevronsUpDown, Building } from "lucide-react";
import { toast } from "sonner";
import { switchWorkspace } from "@/lib/workspace/actions";
import type { Workspace } from "@/lib/workspace/context";

// Which firm you are operating as. Every page below this is scoped to it, so it
// sits at the top of the shell rather than inside Settings — switching is a
// working action, not a configuration one.
//
// With a single workspace it renders as a plain label: there is nothing to
// choose, and a dropdown that only ever contains today's answer is noise.

export function WorkspaceSwitcher({
  workspaces,
  current,
}: {
  workspaces: Workspace[];
  current: Workspace | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!current) {
    return (
      <div className="px-5 py-2 text-xs text-amber-600">
        No workspace — ask an admin to add you.
      </div>
    );
  }

  if (workspaces.length < 2) {
    return (
      <div className="flex items-center gap-2 px-5 py-2 text-xs text-muted-foreground">
        <Building className="size-3.5 shrink-0" />
        <span className="truncate" title={current.name}>
          {current.name}
        </span>
      </div>
    );
  }

  function choose(id: string) {
    if (id === current!.id) return setOpen(false);
    startTransition(async () => {
      try {
        await switchWorkspace(id);
        setOpen(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not switch workspace.");
      }
    });
  }

  return (
    <div className="relative px-3 py-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Building className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 z-40 mt-1 overflow-hidden rounded-md border bg-popover shadow-elev-2">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              disabled={pending}
              onClick={() => choose(w.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <span className="truncate">{w.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{w.role}</span>
              {w.id === current.id && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
