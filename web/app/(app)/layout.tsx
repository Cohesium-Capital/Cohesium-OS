import { getProfile, requireUser } from "@/lib/auth";
import { signOut } from "@/lib/auth-actions";
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
  const claimed = await claimInvites();

  // Scoping context for the whole shell. RLS already limits what this user can
  // reach; this decides which of their workspaces is on screen.
  let [workspaces, workspace] = await Promise.all([myWorkspaces(), currentWorkspace()]);

  // A claim that just created this user's FIRST membership has to be visible to
  // the reads above, or the shell renders request-access to someone who now has
  // a seat — and tells an invitee they have no workspace one second after
  // giving them one. Re-read rather than trusting the ordering: whatever the
  // cause, the invariant worth holding is that these two lines cannot disagree
  // with a claim that returned in the same request.
  if (claimed > 0 && !workspace) {
    [workspaces, workspace] = await Promise.all([myWorkspaces(), currentWorkspace()]);
  }

  // MEMBERSHIP is the gate. Someone signed in with no workspace can already
  // read nothing — every table is gated on membership (028) — so rather than a
  // dead end, they get the front door: tell us who you are, and the operator
  // provisions a workspace for your firm.
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
