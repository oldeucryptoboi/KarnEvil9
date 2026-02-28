"use client";

import { useEffect, useState } from "react";

interface CountdownTimerProps {
  targetDate: string;
  className?: string;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const h = hours % 24;
    return `${days}d ${h}h`;
  }
  if (hours > 0) {
    const m = minutes % 60;
    return `${hours}h ${m}m`;
  }
  if (minutes > 0) {
    const s = seconds % 60;
    return `${minutes}m ${s}s`;
  }
  return `${seconds}s`;
}

export function CountdownTimer({ targetDate, className = "" }: CountdownTimerProps) {
  const [remaining, setRemaining] = useState<number>(() => {
    return new Date(targetDate).getTime() - Date.now();
  });

  useEffect(() => {
    const target = new Date(targetDate).getTime();

    const update = () => {
      setRemaining(target - Date.now());
    };

    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [targetDate]);

  const isPast = remaining <= 0;

  return (
    <span className={`font-mono ${isPast ? "text-yellow-400" : "text-[var(--muted)]"} ${className}`}>
      {isPast ? "overdue" : formatCountdown(remaining)}
    </span>
  );
}
