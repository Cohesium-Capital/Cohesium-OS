"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { CompanyKindFilter, CompanySort } from "./types";

// Search, kind filter, sort and pagination for the companies table. Everything
// goes through the URL so the server component re-queries — same pattern as the
// MSP and review controls, and it keeps a filtered view shareable as a link.

const KINDS: { value: CompanyKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "customer", label: "Customers" },
  { value: "msp", label: "MSPs / targets" },
];

const SORTS: { value: CompanySort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "contacts", label: "Most contacts" },
];

export function CompanyControls({
  q,
  kind,
  sort,
  page,
  pageCount,
  total,
}: {
  q: string;
  kind: CompanyKindFilter;
  sort: CompanySort;
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(q);

  function go(params: {
    q?: string;
    kind?: CompanyKindFilter;
    sort?: CompanySort;
    page?: number;
  }) {
    const sp = new URLSearchParams();
    const nextQ = params.q ?? q;
    const nextKind = params.kind ?? kind;
    const nextSort = params.sort ?? sort;
    const nextPage = params.page ?? 1;
    if (nextQ) sp.set("q", nextQ);
    if (nextKind !== "all") sp.set("kind", nextKind);
    if (nextSort !== "newest") sp.set("sort", nextSort);
    if (nextPage > 1) sp.set("page", String(nextPage));
    router.push(`/companies${sp.toString() ? `?${sp}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: value.trim(), page: 1 });
        }}
        className="flex items-center gap-2"
      >
        <Input
          placeholder="Search companies…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
              setValue("");
              go({ q: "", page: 1 });
            }}
          >
            Clear
          </Button>
        )}
      </form>

      <div className="flex items-center gap-1 rounded-md border p-0.5">
        {KINDS.map((k) => (
          <Button
            key={k.value}
            size="sm"
            variant={kind === k.value ? "secondary" : "ghost"}
            onClick={() => go({ kind: k.value, page: 1 })}
          >
            {k.label}
          </Button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Sort
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
          value={sort}
          onChange={(e) => go({ sort: e.target.value as CompanySort, page: 1 })}
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {total} compan{total === 1 ? "y" : "ies"} · page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => go({ page: page - 1 })}
        >
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => go({ page: page + 1 })}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
