"use client";

import { WSProvider } from "@/lib/ws-context";

export function LayoutProviders({ children }: { children: React.ReactNode }) {
  return <WSProvider>{children}</WSProvider>;
}
