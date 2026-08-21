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
import {
  completeProfile,
  COHESIUM_COPY,
  DEFAULT_PROFILE,
  type WorkspaceProfile,
} from "../workspace/identity";
import {
  personalizationModule,
  type PersonalizationConfig,
  type PersonalizationContact,
} from "../modules/personalization";

// Cohesium's profile: the built-in identity with their own worked examples,
// which is exactly what migration 039 seeds into their workspace_profile. The
// cohesium_* fixtures were captured BEFORE the default examples were made
// market-neutral, so if this stops reproducing them byte for byte, Cohesium's
// live prompts have moved.
const COHESIUM: WorkspaceProfile = completeProfile({ copy: COHESIUM_COPY });

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

// The channel track's own contacts. Separate from CONTACTS because the track is
// selected by org_kind being uniform, and because the tpas= token — the whole
// reason the track exists — only renders from linked_tpas.
const ADVISOR_CONTACTS: DraftContact[] = [
  {
    contact_id: "a-1",
    full_name: "Dana Whitfield",
    persona: "owner",
    title: "Managing Principal",
    company_name: "Keel Point Advisory",
    company_domain: "keelpoint.example",
    city: "Harborview",
    current_msp: null,
    linked_tpas: ["Nova Plan Services", "Cedar Ridge Administrators"],
    org_kind: "advisor",
    channels: ["email", "linkedin"],
    hook_text: "Wrote a client note on what changes when a plan administrator is acquired.",
    hook_source_url: "https://keelpoint.example/notes/administrator-transitions",
    hook_kind: "post",
    fallback_angle: null,
  },
  {
    contact_id: "a-2",
    full_name: "Alex Moreau",
    persona: "head_of_it",
    title: null,
    company_name: "Fairlane Benefits Group",
    company_domain: null,
    city: null,
    current_msp: null,
    // Deliberately empty: the prompt has a rule for this case and a fixture
    // that never exercises it would not protect the rule.
    linked_tpas: [],
    org_kind: "advisor",
    channels: ["linkedin"],
    hook_text: null,
    hook_source_url: null,
    hook_kind: "none",
    fallback_angle: "Runs plan relationships for a regional benefits practice.",
  },
];

const MODES: SourcingMode[] = [
  "research_msps",
  "research_customers",
  "find_customers_for_msps",
  "find_advisors_for_msps",
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

/**
 * Both tracks across all three drafting entry points, rendered twice: with the
 * neutral built-in default, and with Cohesium's own examples.
 *
 * Two sets because the two things being protected are different. The plain
 * fixtures pin what a NEW workspace gets. The cohesium_ ones pin what Cohesium
 * actually sends, which must not have moved at all.
 */
function draftingVariants(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const profiles: [string, WorkspaceProfile | undefined][] = [
    ["", undefined],
    ["cohesium_", COHESIUM],
  ];
  for (const [prefix, profile] of profiles) {
    for (const kind of ["customer", "msp", "advisor"] as TrackKind[]) {
      const contacts = kind === "advisor" ? ADVISOR_CONTACTS : CONTACTS;
      for (const [label, learned] of [
        ["no-learned", ""],
        ["learned", LEARNED],
      ] as const) {
        out.push({
          name: `${prefix}drafting_${kind}_${label}_template`,
          text: buildDraftTemplate(kind, learned, profile),
        });
        out.push({
          name: `${prefix}drafting_${kind}_${label}_single`,
          text: buildDraftPrompt(contacts, kind, learned, profile),
        });
        out.push({
          name: `${prefix}drafting_${kind}_${label}_agent`,
          text: buildDraftAgentPrompt(contacts, 15, kind, learned, profile),
        });
      }
    }
  }
  return out;
}

/**
 * Hook research, which had no golden coverage at all until the vocabulary
 * reached it — so nothing proved that making its one market-specific line
 * configurable left Cohesium's prompt alone.
 *
 * Rendered under two vocabularies rather than two example sets: unlike drafting,
 * this prompt carries no worked examples, so the only thing a tenant changes in
 * it is the vocabulary. `default_` is Cohesium's exact prior text; `tpa_` is the
 * second tenant's market, and exists so a substitution that silently stops
 * happening shows up as a diff instead of as fluent wrong output.
 */
function personalizationVariants(): { name: string; text: string }[] {
  const contacts: PersonalizationContact[] = [
    {
      contact_id: "c-1",
      full_name: "Ana Delgado",
      title: "Practice Owner",
      company_name: "Bright Harbor Clinics",
      company_domain: "brightharbor.example",
      current_msp: "Harbor IT",
    },
    {
      contact_id: "c-2",
      full_name: "Ravi Menon",
      title: null,
      company_name: "Cobalt Freight",
      company_domain: null,
      current_msp: null,
    },
  ];

  const TPA = completeProfile({
    // Named, unlike the drafting variants' vocab-only profiles: the fan-out
    // preamble interpolates the firm and sender, and a fixture that said
    // "Ripley at Cohesium" under TPA vocabulary would read as a chimera to the
    // next person diffing it.
    firmName: "Ilium Holdings",
    senderName: "Saagar",
    vocab: {
      ...DEFAULT_PROFILE.vocab,
      providerSingular: "third-party administrator",
      providerPlural: "third-party administrators",
      providerAbbrev: "TPA",
      providerAbbrevPlural: "TPAs",
      providerGeneric: "TPA",
      market: "retirement TPA market",
      marketShort: "retirement TPA",
      customerFunction: "HR or benefits",
      providerCasual: "TPA",
    },
  });

  const out: { name: string; text: string }[] = [];
  for (const [prefix, profile] of [
    ["default_", DEFAULT_PROFILE],
    ["tpa_", TPA],
  ] as const) {
    for (const [label, learned] of [
      ["no-learned", ""],
      ["learned", LEARNED],
    ] as const) {
      const config: PersonalizationConfig = {
        contacts,
        profile,
        ...(learned ? { learnedRules: learned } : {}),
      };
      out.push({
        name: `personalization_${prefix}${label}_template`,
        text: personalizationModule.templateText!(config),
      });
      out.push({
        name: `personalization_${prefix}${label}_rendered`,
        text: personalizationModule.renderPrompt(null, config),
      });
      out.push({
        name: `personalization_${prefix}${label}_agent`,
        text: personalizationModule.renderPrompt(null, { ...config, mode: "agent" }),
      });
    }
  }
  return out;
}

export function allPromptVariants(): { name: string; text: string }[] {
  return [
    ...sourcingVariants(),
    ...draftingVariants(),
    ...personalizationVariants(),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
