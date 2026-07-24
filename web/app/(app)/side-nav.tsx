"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Radar,
  ClipboardCheck,
  GraduationCap,
  PenLine,
  Send,
  Building2,
  Activity,
  Settings,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { signOut } from "@/lib/auth-actions";
import { cn } from "@/lib/utils";

// Primary navigation. Grouped to mirror the mental model: the PIPELINE group is
// the workflow in order (numbered 1–5 so the sequence is self-evident), DATA is
// reference, and Settings sits at the foot. The active route is always
// highlighted — the one thing the old flat top-nav never showed.

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  step?: number;
  exact?: boolean;
};

const PIPELINE: NavItem[] = [
  { href: "/source", label: "Source", icon: Radar, step: 1 },
  { href: "/review", label: "Review", icon: ClipboardCheck, step: 2, exact: true },
  { href: "/review/grade", label: "Grade", icon: GraduationCap, step: 3 },
  { href: "/draft", label: "Draft", icon: PenLine, step: 4, exact: true },
  { href: "/draft/queue", label: "Send", icon: Send, step: 5 },
];

const DATA: NavItem[] = [
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/msps", label: "MSPs", icon: Building2 },
];

const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings };

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-brand-gradient text-primary-foreground shadow-elev-1"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {item.step ? (
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold tabular-nums",
            active
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-muted text-muted-foreground group-hover:bg-background",
          )}
        >
          {item.step}
        </span>
      ) : (
        <Icon className="size-4 shrink-0" />
      )}
      <span>{item.label}</span>
    </Link>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-4 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
      {children}
    </p>
  );
}

export function SideNav({ email }: { email?: string | null }) {
  const pathname = usePathname();

  const groups = (
    <>
      <GroupLabel>Pipeline</GroupLabel>
      <div className="flex flex-col gap-0.5">
        {PIPELINE.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>
      <GroupLabel>Data</GroupLabel>
      <div className="flex flex-col gap-0.5">
        {DATA.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden border-r border-border/60 bg-card/50 backdrop-blur-md lg:fixed lg:inset-y-0 lg:flex lg:w-60 lg:flex-col">
        <Link href="/" className="flex h-14 items-center px-5">
          <span className="text-brand-gradient text-base font-semibold tracking-tight">
            Cohesium Intel
          </span>
        </Link>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">{groups}</nav>
        <div className="border-t border-border/60 p-3">
          <NavLink item={SETTINGS} pathname={pathname} />
          <div className="mt-2 flex items-center justify-between gap-2 px-3 py-1">
            <span className="truncate text-xs text-muted-foreground" title={email ?? undefined}>
              {email}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                title="Sign out"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-card/80 backdrop-blur-md lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/" className="text-brand-gradient text-base font-semibold tracking-tight">
            Cohesium Intel
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              title="Sign out"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2">
          {[...PIPELINE, ...DATA, SETTINGS].map((item) => {
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium transition-colors",
                  active
                    ? "bg-brand-gradient text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
