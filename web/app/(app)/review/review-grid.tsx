"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ColumnDef,
  type RowSelectionState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Flag, MoreHorizontal, ExternalLink, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ReviewRow } from "@/lib/sourcing/types";
import { setReviewed, deleteContacts } from "@/lib/sourcing/review-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContactKindBadge } from "@/components/contact-kind-badge";
import { RunBadge, RunDate } from "@/components/run-badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// The grid's selection scopes the Clay push, but the push button lives in the
// enrich card above the grid — this context bridges the two. The grid publishes
// its selected ids; PushToClayButton consumes them. requestClear lets the push
// button reset the grid's selection after a successful push (clearSignal is a
// monotonic counter the grid watches).
const ReviewSelectionContext = createContext<{
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  clearSignal: number;
  requestClear: () => void;
} | null>(null);

export function ReviewSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clearSignal, setClearSignal] = useState(0);
  const requestClear = useCallback(() => setClearSignal((n) => n + 1), []);
  const value = useMemo(
    () => ({ selectedIds, setSelectedIds, clearSignal, requestClear }),
    [selectedIds, clearSignal, requestClear],
  );
  return (
    <ReviewSelectionContext.Provider value={value}>
      {children}
    </ReviewSelectionContext.Provider>
  );
}

export function useReviewSelection() {
  const ctx = useContext(ReviewSelectionContext);
  if (!ctx) throw new Error("useReviewSelection requires ReviewSelectionProvider");
  return ctx;
}

function confidenceVariant(c: string | null): "default" | "secondary" | "destructive" {
  if (c === "low") return "destructive";
  if (c === "medium") return "secondary";
  return "default";
}

const PERSONA_LABEL: Record<string, string> = {
  owner: "Owner",
  head_of_it: "Head of IT",
  other: "Other",
};

export function ReviewGrid({
  initialRows,
  q,
  needsReviewOnly,
  runId,
  page,
  pageCount,
  total,
}: {
  initialRows: ReviewRow[];
  q: string;
  needsReviewOnly: boolean;
  /** Active ?run= scope, preserved across search/filter/pagination. */
  runId?: string | null;
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(q);
  // Default to all rows on this page selected (send-to-all default). Component is
  // keyed by page/query upstream, so this re-inits on navigation.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>(() =>
    Object.fromEntries(initialRows.map((r) => [r.id, true])),
  );
  // Soft-delete confirmation: ids awaiting deletion + one shared optional reason.
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleteReason, setDeleteReason] = useState("");

  const { setSelectedIds, clearSignal } = useReviewSelection();
  // Publish the selection so the enrich card's push button can scope to it.
  // Intersect with the current rows (not raw selection-state keys): after a
  // delete/mark-reviewed refresh the grid keeps its key, so rowSelection can
  // hold ids of rows no longer in the data — those must not scope the push.
  useEffect(() => {
    setSelectedIds(initialRows.filter((r) => rowSelection[r.id]).map((r) => r.id));
  }, [rowSelection, initialRows, setSelectedIds]);

  // The push button bumps clearSignal after a successful push; drop the
  // selection so the just-pushed rows aren't one click from a re-push. The ref
  // guard ignores the mount-time value (a fresh page keeps its select-all
  // default even if a push happened earlier in the session).
  const lastClearSignal = useRef(clearSignal);
  useEffect(() => {
    if (clearSignal !== lastClearSignal.current) {
      lastClearSignal.current = clearSignal;
      setRowSelection({});
    }
  }, [clearSignal]);

  function navigate(next: { q?: string; page?: number; needsReviewOnly?: boolean }) {
    const sp = new URLSearchParams();
    const nq = next.q ?? q;
    const np = next.page ?? 1;
    const nf = next.needsReviewOnly ?? needsReviewOnly;
    if (nq) sp.set("q", nq);
    if (np > 1) sp.set("page", String(np));
    if (nf) sp.set("needs_review", "1");
    // Searching or paging inside a run must not silently widen to every contact.
    if (runId) sp.set("run", runId);
    router.push(`/review${sp.toString() ? `?${sp}` : ""}`);
  }

  function run(fn: () => Promise<void>, ok: string) {
    startTransition(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed.");
      }
    });
  }

  const columns = useMemo<ColumnDef<ReviewRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all"
            checked={table.getIsAllRowsSelected()}
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label="Select row"
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
          />
        ),
      },
      {
        id: "needs_review",
        header: "",
        cell: ({ row }) =>
          row.original.reviewed ? null : (
            <span
              className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-amber-600"
              title="Nobody has vetted this contact yet. Check it, then mark it reviewed — only reviewed contacts can be enriched."
            >
              <Flag className="size-3.5" />
              Needs review
            </span>
          ),
      },
      {
        accessorKey: "full_name",
        header: "Contact",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span>{row.original.full_name ?? "—"}</span>
            {row.original.title && (
              <span className="text-xs text-muted-foreground">{row.original.title}</span>
            )}
          </div>
        ),
      },
      {
        id: "run",
        header: "Run",
        cell: ({ row }) => (
          <RunBadge code={row.original.run_code} runId={row.original.run_id} />
        ),
      },
      {
        id: "run_at",
        header: "Run date",
        cell: ({ row }) => <RunDate at={row.original.run_at} />,
      },
      {
        accessorKey: "persona",
        header: "Persona",
        cell: ({ row }) => (
          <Badge variant="outline">
            {PERSONA_LABEL[row.original.persona ?? "other"] ?? "Other"}
          </Badge>
        ),
      },
      {
        accessorKey: "org_name",
        header: "Company",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              {row.original.org_name}
              <ContactKindBadge kind={row.original.org_kind} />
            </span>
            {row.original.org_domain && (
              <span className="text-xs text-muted-foreground">
                {row.original.org_domain}
              </span>
            )}
          </div>
        ),
      },
      {
        accessorKey: "estimated_msp",
        header: "Estimated provider",
        cell: ({ row }) =>
          row.original.estimated_msp ? (
            <Link
              href={`/msps?q=${encodeURIComponent(row.original.estimated_msp)}`}
              className="underline-offset-2 hover:underline"
            >
              {row.original.estimated_msp}
            </Link>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "confidence",
        header: "Confidence",
        cell: ({ row }) => (
          <Badge variant={confidenceVariant(row.original.confidence)}>
            {row.original.confidence ?? "—"}
          </Badge>
        ),
      },
      {
        accessorKey: "enrichment_status",
        header: "Enrichment",
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.enrichment_status}</Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon" className="size-8">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    run(
                      () => setReviewed([r.id], !r.reviewed),
                      r.reviewed ? "Marked as needs review." : "Marked reviewed.",
                    )
                  }
                >
                  <Check className="size-4" />
                  {r.reviewed ? "Mark needs review" : "Mark reviewed"}
                </DropdownMenuItem>
                {r.linkedin_url && (
                  <DropdownMenuItem
                    render={
                      <a
                        href={r.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    <ExternalLink className="size-4" />
                    Open LinkedIn
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteIds([r.id])}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const table = useReactTable({
    data: initialRows,
    columns,
    state: { rowSelection },
    getRowId: (r) => r.id,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  });

  const selectedIds = table.getSelectedRowModel().rows.map((r) => r.original.id);

  return (
    <div className="flex flex-col gap-3" data-tour="review-grid">
      <div className="flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q: search.trim(), page: 1 });
          }}
          className="flex items-center gap-2"
        >
          <Input
            placeholder="Search company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {q && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                navigate({ q: "", page: 1 });
              }}
            >
              Clear
            </Button>
          )}
        </form>

        <label
          className="flex items-center gap-2 text-sm"
          title="Show only contacts nobody has vetted yet"
        >
          <Checkbox
            checked={needsReviewOnly}
            onCheckedChange={(v) => navigate({ needsReviewOnly: !!v, page: 1 })}
          />
          Needs review only
        </label>

        {selectedIds.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {selectedIds.length} selected
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(() => setReviewed(selectedIds, true), "Marked reviewed.")}
            >
              Mark reviewed
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => setDeleteIds(selectedIds)}
            >
              Delete
            </Button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            {total} row{total === 1 ? "" : "s"} · page {page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => navigate({ page: page - 1 })}
          >
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount}
            onClick={() => navigate({ page: page + 1 })}
          >
            Next
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {q || needsReviewOnly
                    ? "No rows match."
                    : "No rows yet. Source and import some contacts to get started."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-amber-600">
          <Flag className="size-3" />
          Needs review
        </span>
        <span>
          = nobody has vetted this contact yet. It is not a quality warning — every sourced
          contact starts this way, and the marker clears when you hit &ldquo;Mark
          reviewed&rdquo;. Confidence is the separate column.
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        Selection and bulk actions apply to the current page. The selection also scopes the
        Clay push in step B above.
      </p>

      <Dialog open={!!deleteIds} onOpenChange={(o) => !o && setDeleteIds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete{" "}
              {(deleteIds?.length ?? 0) === 1 ? "this contact" : `${deleteIds?.length ?? 0} contacts`}?
            </DialogTitle>
            <DialogDescription>
              Removed from every list and never pushed to Clay, but kept on record (soft
              delete). An optional reason is stored with each row.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Reason (optional), e.g. wrong ICP"
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteIds(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                const ids = deleteIds ?? [];
                setDeleteIds(null);
                setDeleteReason("");
                run(() => deleteContacts(ids, deleteReason || undefined), "Deleted.");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
