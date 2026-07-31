import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// OAuth redirect target. Exchanges the code for a session.
//
// No instance-level gate here: workspace membership IS the access model (028),
// and every table is gated on it, so a signed-in stranger reads nothing and is
// offered the request-access form rather than a dead end.
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

  return NextResponse.redirect(`${origin}${next}`);
}
