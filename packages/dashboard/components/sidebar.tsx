"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Sessions", icon: "S" },
  { href: "/approvals", label: "Approvals", icon: "A" },
  { href: "/schedules", label: "Schedules", icon: "C" },
  { href: "/tools", label: "Tools", icon: "T" },
  { href: "/vault", label: "Vault", icon: "V" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 h-full w-56 border-r border-[var(--border)] bg-[var(--card)] flex flex-col">
      <div className="p-4 border-b border-[var(--border)]">
        <h1 className="text-lg font-bold tracking-tight">KarnEvil9</h1>
        <p className="text-xs text-[var(--muted)]">Dashboard</p>
      </div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
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
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
