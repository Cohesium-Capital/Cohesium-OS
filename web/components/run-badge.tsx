import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format/date";

// One visual encoding for a run identifier, used on every records table. The
// code reads <seq>-<mode>: 16-C is the sixteenth run, sourcing customers;
// 9-TCC sourced customers of target companies. Keep it identical everywhere or
// it stops being the thing you can say out loud and search for.

const MODE_TITLE: Record<string, string> = {
  C: "Customers",
  T: "Target companies (MSPs)",
  TCC: "Customers of target companies",
  P: "Personalization run",
  D: "Drafting run",
  E: "Enrichment run",
  R: "Run",
};

export function RunBadge({
  code,
  runId,
  className,
}: {
  code: string | null;
  runId?: string | null;
  className?: string;
}) {
  if (!code) return <span className="text-xs text-muted-foreground">—</span>;

  const mode = code.split("-")[1] ?? "";
  const badge = (
    <Badge variant="outline" className={`font-mono text-xs ${className ?? ""}`}>
      {code}
    </Badge>
  );

  return (
    <span title={MODE_TITLE[mode] ?? "Run"}>
      {runId ? (
        <Link href={`/runs/${runId}`} className="underline-offset-2 hover:underline">
          {badge}
        </Link>
      ) : (
        badge
      )}
    </span>
  );
}

/** The run's date, for the paired "Run date" column. */
export function RunDate({ at }: { at: string | null }) {
  if (!at) return <span className="text-xs text-muted-foreground">—</span>;
  return <span className="whitespace-nowrap text-xs">{formatDate(at)}</span>;
}
