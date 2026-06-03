"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Search + pagination for the MSP table. Drives everything through the URL so the
// server component re-queries; nothing is loaded client-side.
export function MspControls({
  q,
  page,
  pageCount,
  total,
}: {
  q: string;
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(q);

  function go(params: { q?: string; page?: number }) {
    const sp = new URLSearchParams();
    const nextQ = params.q ?? q;
    const nextPage = params.page ?? 1;
    if (nextQ) sp.set("q", nextQ);
    if (nextPage > 1) sp.set("page", String(nextPage));
    router.push(`/msps${sp.toString() ? `?${sp}` : ""}`);
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
          placeholder="Search MSPs…"
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

      <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {total} MSP{total === 1 ? "" : "s"} · page {page} of {pageCount}
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
