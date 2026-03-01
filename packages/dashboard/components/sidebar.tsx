"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWSContext } from "@/lib/ws-context";
import { useApprovals } from "@/lib/approvals-context";

const NAV_ITEMS = [
  { href: "/", label: "Sessions", icon: "S" },
  { href: "/approvals", label: "Approvals", icon: "A" },
  { href: "/journal", label: "Journal", icon: "J" },
  { href: "/schedules", label: "Schedules", icon: "C" },
  { href: "/tools", label: "Tools", icon: "T" },
  { href: "/plugins", label: "Plugins", icon: "P" },
  { href: "/vault", label: "Vault", icon: "V" },
  { href: "/swarm", label: "Swarm", icon: "W" },
  { href: "/metrics", label: "Metrics", icon: "M" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { connected } = useWSContext();
  const { pendingCount } = useApprovals();

  return (
    <aside className="fixed left-0 top-0 h-full w-56 border-r border-[var(--border)] bg-[var(--card)] flex flex-col">
      <div className="p-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">KarnEvil9</h1>
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
            title={connected ? "WebSocket connected" : "WebSocket disconnected"}
          />
        </div>
        <p className="text-xs text-[var(--muted)]">Dashboard</p>
      </div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
          const showBadge = item.href === "/approvals" && pendingCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5"
              }`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded bg-white/5 text-xs font-mono">
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              {showBadge && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-400 tabular-nums">
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
