import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RunBadge } from "@/components/run-badge";
import { formatDate } from "@/lib/format/date";
import type { RunScope } from "@/lib/runs/scope";

// Shown whenever a stage page is narrowed to one run. A scoped page that looks
// identical to an unscoped one is the bug this prevents: the operator needs to
// know the action they are about to take covers 4 records, not 400.
export function RunScopeBanner({
  scope,
  basePath,
  noun = "records",
}: {
  scope: RunScope | null;
  /** Path to return to, unscoped. */
  basePath: string;
  noun?: string;
}) {
  if (!scope) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
      <RunBadge code={scope.code} runId={scope.runId} />
      <span>
        Scoped to this run{scope.runAt ? ` from ${formatDate(scope.runAt)}` : ""} —{" "}
        <strong className="tabular-nums">{scope.contactIds.length}</strong> {noun}. Everything on
        this page acts on those only.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto"
        nativeButton={false}
        render={<Link href={basePath} />}
      >
        Clear run filter
      </Button>
    </div>
  );
}
