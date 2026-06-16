import type { ModuleKey, RunModule } from "./types";
import { sourcingModule } from "./sourcing";
import { enrichmentModule } from "./enrichment";
import { personalizationModule } from "./personalization";
import { draftingModule } from "./drafting";

// The module registry: one entry per pipeline stage. The run lifecycle looks a
// module up by key to render its prompt, validate its output, and ingest it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MODULES: Record<ModuleKey, RunModule<any, any>> = {
  sourcing: sourcingModule,
  enrichment: enrichmentModule,
  personalization: personalizationModule,
  drafting: draftingModule,
};

export function getModule(key: ModuleKey) {
  const m = MODULES[key];
  if (!m) throw new Error(`unknown module: ${key}`);
  return m;
}

export const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];
