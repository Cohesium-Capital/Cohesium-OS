export type SendReport = {
  ok: boolean;
  error?: string;
  emailQueued: number; // queued for the SMTP drip worker
  linkedinQueued: number; // handed to HeyReach; 'sent' only on its SENT webhook
  /** @deprecated alias of linkedinQueued, kept until the queue page migrates */
  linkedinSent: number;
  skippedResponded: number; // contacts who already replied
  skippedSuppressed: number; // contacts with an active/pending suppression
  skippedLinkedinCap: number; // held back by the rolling-24h LINKEDIN_DAILY_CAP
  errors: string[];
};

export const EMPTY_SEND_REPORT: SendReport = {
  ok: true,
  emailQueued: 0,
  linkedinQueued: 0,
  linkedinSent: 0,
  skippedResponded: 0,
  skippedSuppressed: 0,
  skippedLinkedinCap: 0,
  errors: [],
};
