"use client";

import { WSProvider } from "@/lib/ws-context";
import { ToastProvider } from "@/components/toast";
import { ApprovalsProvider } from "@/lib/approvals-context";
import { WSToastBridge } from "@/components/ws-toast-bridge";

export function LayoutProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <WSProvider>
        <ApprovalsProvider>
          <WSToastBridge />
          {children}
        </ApprovalsProvider>
      </WSProvider>
    </ToastProvider>
  );
}
