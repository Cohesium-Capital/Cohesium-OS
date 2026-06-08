import { z } from "zod";

// Contract for drafted messages pasted back from Claude/ChatGPT. Each draft
// echoes the contact_id (so we write to the right contact) and its channel.

export const CHANNELS = ["email", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

const optStr = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().nullish(),
);

export const DraftSchema = z.object({
  contact_id: z.string().min(1, "contact_id required"),
  channel: z.enum(CHANNELS),
  subject: optStr, // email only
  body: z.string().trim().min(1, "body required"),
});

export const DraftsPayloadSchema = z.object({
  drafts: z.array(DraftSchema).min(1, "no drafts"),
});

export type Draft = z.infer<typeof DraftSchema>;
export type DraftsPayload = z.infer<typeof DraftsPayloadSchema>;
