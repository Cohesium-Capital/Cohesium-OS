export type SendReport = {
  ok: boolean;
  error?: string;
  emailSent: number;
  linkedinSent: number;
  skippedResponded: number; // contacts who already replied
  errors: string[];
};

export const EMPTY_SEND_REPORT: SendReport = {
  ok: true,
  emailSent: 0,
  linkedinSent: 0,
  skippedResponded: 0,
  errors: [],
};
