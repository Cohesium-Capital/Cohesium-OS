export type SendReport = {
  ok: boolean;
  error?: string;
  emailQueued: number; // queued for the SMTP drip worker
  linkedinSent: number; // pushed to HeyReach
  skippedResponded: number; // contacts who already replied
  errors: string[];
};

export const EMPTY_SEND_REPORT: SendReport = {
  ok: true,
  emailQueued: 0,
  linkedinSent: 0,
  skippedResponded: 0,
  errors: [],
};
