import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "admin" | "member" | "partner";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
};

// Memoized per render pass. The authoritative auth check — getUser() revalidates
// the token against Supabase rather than trusting the cookie.
export const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", user.id)
    .maybeSingle();
  return (data as Profile) ?? null;
});

// Use in protected server components / actions. Redirects to /login if absent.
export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}
