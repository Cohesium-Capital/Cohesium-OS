import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// OAuth redirect target. Exchanges the code for a session, then enforces the
// email allowlist before letting the user in.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Only a same-origin path may ride the redirect: "https://evil.com" or the
  // "//evil.com" and "/\\evil.com" protocol-relative forms would bounce a
  // just-authenticated user to another site (or crash URL parsing into a 500).
  const rawNext = searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !/^\/[\\/]/.test(rawNext) ? rawNext : "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.length) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const email = user?.email?.toLowerCase();
    if (!email || !allowed.includes(email)) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=not_allowed`);
    }
  }

  return NextResponse.redirect(`${origin}${next}`);
}
