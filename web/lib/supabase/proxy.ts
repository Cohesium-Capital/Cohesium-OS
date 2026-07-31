import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";

// Refreshes the Supabase session on every request and gates access: signed-out
// users are sent to /login, signed-in users on /login are sent to / (the work queue).
// Called from the root proxy.ts (Next.js 16's renamed middleware).
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() revalidates the token. Do not run code between creating
  // the client and this call.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // /api routes authenticate themselves (webhook secret or session check), so
  // they must not be redirected to /login by the optimistic gate here.
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api");

  // The ALLOWED_EMAILS gate, enforced HERE rather than only at sign-in.
  //
  // Magic links land on /login?code=…, where the exchange happens in the browser
  // because the PKCE verifier is in the browser's storage — so the callback
  // route that used to hold this check is not on the path a real sign-in takes.
  // A session could therefore exist for an address the list excludes. Checking
  // per request is the only version of this that is true whatever created the
  // session.
  if (user && !isAllowedEmail(user.email)) {
    await supabase.auth.signOut();
    // /api authenticates itself and must not be handed a redirect: an agent or
    // a webhook would follow it and try to parse an HTML login page as JSON.
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "account is not on the access list" }, { status: 403 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("error", "not_allowed");
    const denied = NextResponse.redirect(url);
    // signOut() cleared the auth cookies onto `response` via the setAll adapter
    // above; carry them over, or the redirect would leave the session intact and
    // /login would bounce the user straight back into a loop.
    response.cookies.getAll().forEach((cookie) => denied.cookies.set(cookie));
    return denied;
  }

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}
