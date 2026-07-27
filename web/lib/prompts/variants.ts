import {
  buildPrompt as buildSourcingPrompt,
  buildTemplateText as buildSourcingTemplate,
  type PromptParams,
  type SourcingMode,
} from "../sourcing/prompts";
import {
  buildDraftPrompt,
  buildDraftAgentPrompt,
  buildTemplateText as buildDraftTemplate,
  type DraftContact,
  type TrackKind,
} from "../drafting/prompt";

// Every prompt shape the system can render, enumerated once.
//
// This exists for the golden-snapshot test. Making per-workspace vocabulary
// possible means touching the text of nearly every prompt, and the requirement
// is that Cohesium's rendered output does not move by a single byte. Eyeballing
// a diff across ~900 lines of prompt text cannot establish that; a fixture per
// variant can.
//
// Inputs are fixed and boring on purpose — the fixtures must change only when
// the prompt text genuinely changes, never because a date or an id moved.

const KNOWN = [
  { name: "Acme Dental", domain: "acmedental.com", mspName: "Harbor IT" },
  { name: "Bluefin Legal", domain: null, mspName: "Harbor IT" },
  { name: "Cobalt Freight", domain: "cobaltfreight.com", mspName: "Summit Networks" },
];

const MSPS = [
  { id: "m1", name: "Harbor IT", domain: "harborit.com" },
  { id: "m2", name: "Summit Networks", domain: null },
];

const LEARNED = `Learned from previous human edits (these come from real corrections to earlier
output — follow them as strictly as the rules above):
- Lead with the recipient's own words when the hook is a talk or a post.`;

const CONTACTS: DraftContact[] = [
  {
    contact_id: "c-1",
    full_name: "Ana Delgado",
    persona: "owner",
    title: "Practice Owner",
    company_name: "Bright Harbor Clinics",
    company_domain: "brightharbor.example",
    city: "Harborview",
    current_msp: "Harbor IT",
    org_kind: "customer",
    channels: ["email", "linkedin"],
    hook_text: "Spoke at the Harborview Clinic Ops Summit on EHR migrations.",
    hook_source_url: "https://brightharbor.example/news/ops-summit",
    hook_kind: "talk",
    fallback_angle: null,
  },
  {
    contact_id: "c-2",
    full_name: "Tom Reyes",
    persona: "head_of_it",
    title: null,
    company_name: "Northlake Logistics",
    company_domain: null,
    city: null,
    current_msp: null,
    org_kind: "msp",
    channels: ["linkedin"],
    hook_text: null,
    hook_source_url: null,
    hook_kind: "none",
    fallback_angle: "Runs IT for a logistics firm opening a second warehouse.",
  },
];

const MODES: SourcingMode[] = [
  "research_msps",
  "research_customers",
  "find_customers_for_msps",
];

/** Every (mode, exclusion-shape, profile) combination the sourcing prompt has. */
function sourcingVariants(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const mode of MODES) {
    // The three exclusion shapes are mutually exclusive branches in the
    // template, and each produces a different prompt_version hash.
    const shapes: [string, Partial<PromptParams>][] = [
      ["no-exclusions", {}],
      ["embedded-known", { known: KNOWN, knownOmitted: 12 }],
      ["via-api", { checkKnownViaApi: true }],
    ];
    for (const [shape, extra] of shapes) {
      for (const profile of ["", "10-200 employees, professional services"]) {
        for (const learned of ["", LEARNED]) {
          const params: PromptParams = {
            mode,
            region: "Virginia",
            profile,
            count: 25,
            countPer: 10,
            msps: MSPS,
            learnedRules: learned,
            ...extra,
          };
          const suffix = [
            shape,
            profile ? "profile" : "no-profile",
            learned ? "learned" : "no-learned",
          ].join("_");
          out.push({
            name: `sourcing_${mode}_${suffix}_template`,
            text: buildSourcingTemplate(params),
          });
          out.push({
            name: `sourcing_${mode}_${suffix}_rendered`,
            text: buildSourcingPrompt(params),
          });
        }
      }
    }
  }
  return out;
}

/** Both tracks across all three drafting entry points. */
function draftingVariants(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const kind of ["customer", "msp"] as TrackKind[]) {
    for (const [label, learned] of [
      ["no-learned", ""],
      ["learned", LEARNED],
    ] as const) {
      out.push({
        name: `drafting_${kind}_${label}_template`,
        text: buildDraftTemplate(kind, learned),
      });
      out.push({
        name: `drafting_${kind}_${label}_single`,
        text: buildDraftPrompt(CONTACTS, kind, learned),
      });
      out.push({
        name: `drafting_${kind}_${label}_agent`,
        text: buildDraftAgentPrompt(CONTACTS, 15, kind, learned),
      });
    }
  }
  return out;
}

export function allPromptVariants(): { name: string; text: string }[] {
  return [...sourcingVariants(), ...draftingVariants()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
