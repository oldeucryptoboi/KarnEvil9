"use client";

import { WSProvider } from "@/lib/ws-context";
import { ToastProvider } from "@/components/toast";
import { WSToastBridge } from "@/components/ws-toast-bridge";

export function LayoutProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <WSProvider>
        <WSToastBridge />
        {children}
      </WSProvider>
    </ToastProvider>
  );
}
