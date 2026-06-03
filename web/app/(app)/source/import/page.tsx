"use client";

import { useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { toast } from "sonner";
import { importSourced } from "@/lib/sourcing/import";
import type { ImportKind, ImportReport } from "@/lib/sourcing/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// CSV columns we recognize (Mode C: a Google Sheets export). Everything else is
// ignored. Converted to the same JSON payload the model produces.
type CsvRow = Record<string, string>;

function csvToPayloadJson(csv: string): string {
  const { data } = Papa.parse<CsvRow>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const organizations = data
    .filter((r) => (r.name ?? "").trim())
    .map((r) => ({
      name: r.name,
      domain: r.domain ?? null,
      hq_city: r.hq_city ?? r.city ?? null,
      hq_state: r.hq_state ?? r.state ?? null,
      current_msp_name: r.current_msp_name ?? null,
      // A hand-curated list is trusted unless the row says otherwise.
      confidence: r.confidence ?? "high",
      contacts: [],
    }));
  return JSON.stringify({ organizations });
}

export default function ImportPage() {
  const [kind, setKind] = useState<ImportKind>("msp");
  const [json, setJson] = useState("");
  const [csv, setCsv] = useState("");
  const [tab, setTab] = useState("json");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  async function run() {
    setLoading(true);
    setReport(null);
    try {
      let rawText: string;
      if (tab === "csv") {
        if (!csv.trim()) {
          toast.error("Paste or upload CSV first.");
          return;
        }
        rawText = csvToPayloadJson(csv);
      } else {
        if (!json.trim()) {
          toast.error("Paste the JSON first.");
          return;
        }
        rawText = json;
      }
      const result = await importSourced({ rawText, kind });
      setReport(result);
      if (result.ok) {
        toast.success(
          `Imported ${result.inserted.organizations} org(s), ${result.inserted.contacts} contact(s).`,
        );
      } else {
        toast.error("Import failed — see details below.");
      }
    } catch (e) {
      setReport(null);
      toast.error(e instanceof Error ? e.message : "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setCsv);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Import</h1>
          <p className="text-sm text-muted-foreground">
            Paste the JSON from your research, or upload a CSV of known MSPs.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/review" />}>
          Go to Review →
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What are you importing?</CardTitle>
          <CardDescription>
            This sets the row kind and how MSP links are resolved.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid max-w-xs gap-2">
            <Label>Row kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ImportKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="msp">MSPs (acquisition targets)</SelectItem>
                <SelectItem value="customer">Customers</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="json">Paste JSON</TabsTrigger>
              <TabsTrigger value="csv">Upload / paste CSV</TabsTrigger>
            </TabsList>
            <TabsContent value="json" className="pt-2">
              <Textarea
                placeholder='{ "organizations": [ ... ] }'
                value={json}
                onChange={(e) => setJson(e.target.value)}
                rows={14}
                className="font-mono text-xs"
              />
            </TabsContent>
            <TabsContent value="csv" className="flex flex-col gap-3 pt-2">
              <Input type="file" accept=".csv,text/csv" onChange={onFile} />
              <Textarea
                placeholder="name,domain&#10;Acme MSP,acmemsp.com"
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={10}
                className="font-mono text-xs"
              />
            </TabsContent>
          </Tabs>

          <div>
            <Button onClick={run} disabled={loading}>
              {loading ? "Importing…" : "Import"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {report && (
        <Card>
          <CardHeader>
            <CardTitle>{report.ok ? "Import complete" : "Import failed"}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {report.ok ? (
              <>
                <p>
                  Inserted <strong>{report.inserted.organizations}</strong> organization(s)
                  and <strong>{report.inserted.contacts}</strong> contact(s).
                </p>
                <p className="text-muted-foreground">
                  {report.flagged} flagged for review · {report.skippedDuplicates} skipped as
                  duplicates.
                </p>
              </>
            ) : (
              <p className="text-destructive">{report.error}</p>
            )}
            {report.messages.map((m, i) => (
              <p key={i} className="text-muted-foreground">
                {m}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
