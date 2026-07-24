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
import { SideNav } from "./side-nav";

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
    <div className="min-h-full">
      <SideNav email={email} />
      <div className="flex min-h-full flex-col lg:pl-60">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 lg:px-10">
          {children}
        </main>
      </div>
    </div>
  );
}
