import Link from "next/link";
import { getProfile, requireUser } from "@/lib/auth";
import { signOut } from "@/lib/auth-actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Protected shell for all signed-in pages. The gate is the user (requireUser),
// not the profile row, so a momentarily-missing profile can't cause a redirect
// loop with proxy.ts. RLS is the backstop at the data layer.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // Email allowlist, enforced here on every protected page (sign-in no longer
  // routes through the callback that used to check it).
  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const userEmail = user.email?.toLowerCase();
  if (allowed.length && (!userEmail || !allowed.includes(userEmail))) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>No access</CardTitle>
            <CardDescription>{user.email} is not on the access list.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={signOut}>
              <Button type="submit" variant="outline">
                Sign out
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  const profile = await getProfile();
  const email = profile?.email ?? user.email;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <span className="font-semibold">Cohesium Intel</span>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/source" className="hover:text-foreground">
                Source
              </Link>
              <Link href="/review" className="hover:text-foreground">
                Review
              </Link>
              <Link href="/msps" className="hover:text-foreground">
                MSPs
              </Link>
              <Link href="/draft" className="hover:text-foreground">
                Draft
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{email}</span>
            <form action={signOut}>
              <Button variant="ghost" size="sm" type="submit">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
