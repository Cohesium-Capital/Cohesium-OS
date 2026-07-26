export type DraftReport = {
  ok: boolean;
  error?: string;
  drafted: number; // new planned touches written
  updated: number; // existing drafts replaced
  skippedNoAddress: number; // channel had no email/LinkedIn
  skippedUnknown: number; // contact_id not found
  flaggedOverLimit: number; // LinkedIn drafts over 300 chars — must be re-drafted, not approved
  messages: string[];
};

export const EMPTY_DRAFT_REPORT: DraftReport = {
  ok: true,
  drafted: 0,
  updated: 0,
  skippedNoAddress: 0,
  skippedUnknown: 0,
  flaggedOverLimit: 0,
  messages: [],
};

// One failed send for the queue's "Failed sends" section — the landing spot
// for the home page's failed-sends health chip.
export type FailedRow = {
  id: string;
  channel: string;
  subject: string | null;
  contact_name: string | null;
  company: string;
  last_error: string | null;
};

// One drafted touch for the queue grid.
export type QueueRow = {
  id: string;
  channel: string;
  subject: string | null;
  body: string;
  approved: boolean;
  contact_name: string | null;
  company: string;
  org_kind: string | null; // 'msp' (acquisition target) | 'customer' | 'unknown' (legacy default)
  // Which sourcing run this message's contact came from (migration 024).
  run_code: string | null;
  run_id: string | null;
  run_at: string | null;
};
