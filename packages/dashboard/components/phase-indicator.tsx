"use client";

const PHASES = ["created", "planning", "running", "completed"] as const;

const TERMINAL_MAP: Record<string, string> = {
  failed: "failed",
  aborted: "aborted",
};

const PHASE_COLORS: Record<string, { active: string; done: string; future: string }> = {
  created:   { active: "bg-blue-500",    done: "bg-blue-500/40",    future: "bg-[var(--border)]" },
  planning:  { active: "bg-yellow-500",  done: "bg-yellow-500/40",  future: "bg-[var(--border)]" },
  running:   { active: "bg-green-500",   done: "bg-green-500/40",   future: "bg-[var(--border)]" },
  completed: { active: "bg-emerald-500", done: "bg-emerald-500/40", future: "bg-[var(--border)]" },
  failed:    { active: "bg-red-500",     done: "bg-red-500/40",     future: "bg-[var(--border)]" },
  aborted:   { active: "bg-gray-500",    done: "bg-gray-500/40",    future: "bg-[var(--border)]" },
};

export function PhaseIndicator({ status }: { status: string }) {
  const terminal = TERMINAL_MAP[status];
  const displayPhases = terminal
    ? [...PHASES.slice(0, -1), terminal]
    : [...PHASES];

  const currentIdx = displayPhases.indexOf(terminal ?? status);

  return (
    <div className="flex items-center gap-1">
      {displayPhases.map((phase, i) => {
        const colors = PHASE_COLORS[phase] ?? PHASE_COLORS.created!;
        let dotClass: string;
        let textClass: string;

        if (i === currentIdx) {
          dotClass = `${colors.active} animate-pulse`;
          textClass = "text-[var(--foreground)] font-medium";
        } else if (i < currentIdx) {
          dotClass = colors.done;
          textClass = "text-[var(--muted)]";
        } else {
          dotClass = colors.future;
          textClass = "text-[var(--muted)]/50";
        }

        return (
          <div key={phase} className="flex items-center gap-1">
            {i > 0 && (
              <div className={`h-px w-6 ${i <= currentIdx ? "bg-[var(--muted)]/40" : "bg-[var(--border)]"}`} />
            )}
            <div className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
              <span className={`text-xs capitalize ${textClass}`}>{phase}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
