"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  type ColumnDef,
  type RowSelectionState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Flag, MoreHorizontal, ExternalLink, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ReviewRow } from "@/lib/sourcing/types";
import { setReviewed, deleteContacts } from "@/lib/sourcing/review-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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

export function ReviewGrid({ initialRows }: { initialRows: ReviewRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [globalFilter, setGlobalFilter] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  // Default to all rows selected — the send screen sends to everyone unless you
  // uncheck. Same default applies here for bulk review.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>(() =>
    Object.fromEntries(initialRows.map((r) => [r.id, true])),
  );

  const data = useMemo(
    () => (flaggedOnly ? initialRows.filter((r) => !r.reviewed) : initialRows),
    [initialRows, flaggedOnly],
  );

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
        enableSorting: false,
      },
      {
        id: "flag",
        header: "",
        cell: ({ row }) =>
          row.original.reviewed ? null : (
            <span className="flex items-center text-amber-600" title="Needs review">
              <Flag className="size-4" />
            </span>
          ),
        enableSorting: false,
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
          <div className="flex flex-col">
            <span>{row.original.org_name}</span>
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
        header: "Estimated MSP",
        cell: ({ row }) => row.original.estimated_msp ?? "—",
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
                  onClick={() => run(() => deleteContacts([r.id]), "Deleted.")}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
        enableSorting: false,
      },
    ],
    // run is stable enough for v1; columns do not need to re-create per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const table = useReactTable({
    data,
    columns,
    state: { rowSelection, globalFilter },
    getRowId: (r) => r.id,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, value) => {
      const q = String(value).toLowerCase();
      const r = row.original;
      return [r.full_name, r.org_name, r.estimated_msp, r.org_domain].some((v) =>
        (v ?? "").toLowerCase().includes(q),
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const selectedIds = table.getSelectedRowModel().rows.map((r) => r.original.id);
  const flaggedCount = initialRows.filter((r) => !r.reviewed).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search company, contact, MSP…"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={flaggedOnly}
            onCheckedChange={(v) => setFlaggedOnly(!!v)}
          />
          Flagged only ({flaggedCount})
        </label>
        <div className="ml-auto flex items-center gap-2">
          {selectedIds.length > 0 && (
            <>
              <span className="text-sm text-muted-foreground">
                {selectedIds.length} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() => setReviewed(selectedIds, true), "Marked reviewed.")
                }
              >
                Mark reviewed
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() => run(() => deleteContacts(selectedIds), "Deleted.")}
              >
                Delete
              </Button>
            </>
          )}
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
                  No rows yet. Source and import some contacts to get started.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
