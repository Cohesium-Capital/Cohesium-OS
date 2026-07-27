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
import { currentWorkspace, myWorkspaces } from "@/lib/workspace/context";
import { claimInvites } from "@/lib/workspace/admin-actions";
import { TourProvider } from "@/components/tour/tour-provider";
import { RequestAccess } from "./request-access";
import { myAccessRequest } from "@/lib/access/actions";

// Protected shell for all signed-in pages. The gate is the user (requireUser),
// not the profile row, so a momentarily-missing profile can't cause a redirect
// loop with proxy.ts. RLS is the backstop at the data layer.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  const profile = await getProfile();
  const email = profile?.email ?? user.email;

  // Claim any invite addressed to this email BEFORE deciding whether the user
  // has a workspace. This must live in the layout, not on a page: a brand-new
  // invitee has zero memberships, and the no-workspace branch below would
  // funnel them into request-access — whose approval mints a separate empty
  // tenant instead of the seat they were invited to. It matches on the
  // caller's own JWT email and is a cheap no-op when nothing is waiting.
  await claimInvites();

  // Scoping context for the whole shell. RLS already limits what this user can
  // reach; this decides which of their workspaces is on screen.
  const [workspaces, workspace] = await Promise.all([myWorkspaces(), currentWorkspace()]);

  // MEMBERSHIP is the gate. Someone signed in with no workspace can already
  // read nothing — every table is gated on membership (028) — so rather than a
  // dead end, they get the front door: tell us who you are, and the operator
  // provisions a workspace for your firm.
  //
  // ALLOWED_EMAILS still applies where it is set, but as an instance-level
  // gate rather than the access model: someone outside it never reaches the
  // request form, which is what you want during a closed beta and what you
  // must clear to let strangers in at all.
  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const userEmail = user.email?.toLowerCase();
  const blockedByAllowlist = allowed.length > 0 && (!userEmail || !allowed.includes(userEmail));

  if (blockedByAllowlist) {
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

  if (!workspace) {
    return (
      <RequestAccess
        email={email ?? null}
        existing={await myAccessRequest()}
        signOut={signOut}
      />
    );
  }

  return (
    // TourProvider wraps the whole shell so the Demonstrate walkthrough can
    // overlay any page and survive navigation (state in localStorage).
    <TourProvider>
      <div className="min-h-full">
        <SideNav
          email={email}
          workspaces={workspaces}
          currentWorkspace={workspace}
        />
        <div className="flex min-h-full flex-col lg:pl-60">
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 lg:px-10">
            {children}
          </main>
        </div>
      </div>
    </TourProvider>
  );
}
