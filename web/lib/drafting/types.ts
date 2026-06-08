export type DraftReport = {
  ok: boolean;
  error?: string;
  drafted: number; // new planned touches written
  updated: number; // existing drafts replaced
  skippedNoAddress: number; // channel had no email/LinkedIn
  skippedUnknown: number; // contact_id not found
  messages: string[];
};

export const EMPTY_DRAFT_REPORT: DraftReport = {
  ok: true,
  drafted: 0,
  updated: 0,
  skippedNoAddress: 0,
  skippedUnknown: 0,
  messages: [],
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
};
