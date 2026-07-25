"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { mintToken } from "./token-hash";

// Create and revoke runner API tokens. Runs as the signed-in user, and the
// api_tokens RLS policy is owner-only, so a member can neither read nor mint a
// credential that acts as someone else.

export type CreatedToken = { id: string; name: string; raw: string; prefix: string };

/**
 * Mint a token for the current user. The raw value is returned exactly once —
 * only its hash is stored — so the UI must show it immediately or it is lost.
 */
export async function createApiToken(input: {
  name: string;
  expiresInDays?: number | null;
}): Promise<CreatedToken> {
  const user = await requireUser();
  const name = input.name.trim();
  if (!name) throw new Error("Give the token a name so you can recognise it later.");

  const supabase = await createClient();
  const { raw, hash, prefix } = await mintToken();

  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
      : null;

  const { data, error } = await supabase
    .from("api_tokens")
    .insert({
      name,
      token_hash: hash,
      prefix,
      owner_id: user.id,
      scopes: ["sourcing"],
      expires_at: expiresAt,
    })
    .select("id, name")
    .single();
  if (error) throw new Error(`Could not create token: ${error.message}`);

  revalidatePath("/settings");
  return { id: data.id as string, name: data.name as string, raw, prefix };
}

/** Revoke immediately. Kept as a row (not deleted) so runs stay traceable to
 *  the token that produced them. */
export async function revokeApiToken(id: string): Promise<void> {
  await requireUser();
  const supabase = await createClient();
  const { error } = await supabase
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null);
  if (error) throw new Error(`Could not revoke token: ${error.message}`);
  revalidatePath("/settings");
}
