"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const URL_ERRORS: Record<string, string> = {
  // Distinct from `auth` on purpose. This is the failure a WORKING link produces
  // when it is opened somewhere else — mail apps routinely open their own
  // browser, whose storage does not hold the verifier this exchange needs. It
  // was reported as "invalid or expired", which sends people to request another
  // link, which fails identically, forever.
  same_browser:
    "This link has to be opened in the browser you requested it from — mail apps often open their own. Request a new link below, then open your email in THIS browser and click it there.",
  auth: "Sign-in link was invalid or expired. Request a new one.",
  missing_code: "Sign-in did not complete. Request a new link.",
};

function LoginInner() {
  const params = useSearchParams();
  const urlError = params.get("error");
  // Magic-link code can land here if Supabase's Site URL points at /login.
  // Supabase's Site URL points here, so the code lands on /login rather than
  // /auth/callback. It is exchanged below, in the browser.
  const code = params.get("code");

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    // Exchange in the browser — the PKCE verifier is in this browser's storage,
    // which the server can't reliably read. On success the session cookies are
    // set, then a full reload lets the server see the session.
    const supabase = createClient();
    supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      window.location.replace(error ? "/login?error=same_browser" : "/");
    });
  }, [code]);

  if (code) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Signing you in…</p>
      </div>
    );
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Cohesium Intel</CardTitle>
          <CardDescription>
            {sent
              ? "Check your email for a sign-in link."
              : "Enter your email to get a sign-in link."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {urlError && (
            <p className="text-sm text-destructive">
              {URL_ERRORS[urlError] ?? "Something went wrong."}
            </p>
          )}
          {sent ? (
            <p className="text-sm text-muted-foreground">
              We sent a link to <strong>{email}</strong>. Open it in this browser to
              finish signing in.
            </p>
          ) : (
            <form onSubmit={sendLink} className="flex flex-col gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Sending…" : "Send magic link"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
