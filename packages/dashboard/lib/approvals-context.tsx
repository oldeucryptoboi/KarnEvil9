"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWSContext } from "./ws-context";
import { getApprovals, submitApproval, type ApprovalRequest } from "./api";

/* ---------- Types ---------- */

export interface PendingApproval extends ApprovalRequest {
  /** When the approval was received by the dashboard */
  received_at: string;
}

export interface ResolvedApproval {
  request_id: string;
  tool_name: string;
  session_id: string;
  permissions: Array<{ scope: string }>;
  decision: string;
  resolved_at: string;
}

interface ApprovalsContextValue {
  /** Currently pending approval requests */
  pending: PendingApproval[];
  /** History of resolved approvals (most recent first) */
  history: ResolvedApproval[];
  /** Number of pending approvals */
  pendingCount: number;
  /** Submit a decision for a pending approval */
  decide: (requestId: string, decision: string) => Promise<void>;
  /** Whether a decision is currently being submitted */
  submittingId: string | null;
  /** Last error message */
  error: string | null;
  /** Clear the error */
  clearError: () => void;
}

/* ---------- Context ---------- */

const ApprovalsContext = createContext<ApprovalsContextValue>({
  pending: [],
  history: [],
  pendingCount: 0,
  decide: async () => {},
  submittingId: null,
  error: null,
  clearError: () => {},
});

export function useApprovals() {
  return useContext(ApprovalsContext);
}

/* ---------- Constants ---------- */

const MAX_HISTORY = 50;
const POLL_INTERVAL_MS = 3000;

/* ---------- Provider ---------- */

export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const { events, send, connected } = useWSContext();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [history, setHistory] = useState<ResolvedApproval[]>([]);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const processedCountRef = useRef(0);

  const clearError = useCallback(() => setError(null), []);

  /* --- REST polling for pending approvals (baseline) --- */
  const loadPending = useCallback(async () => {
    try {
      const approvals = await getApprovals();
      setPending((prev) => {
        // Merge REST data with any existing pending items, preserving received_at
        const existingMap = new Map(prev.map((p) => [p.request_id, p]));
        return approvals.map((a) => {
          const existing = existingMap.get(a.request_id);
          return {
            ...a,
            received_at: existing?.received_at ?? a.created_at,
          };
        });
      });
    } catch (e) {
      // Don't overwrite error on polling failures - only set if no error exists
      setError((prev) => prev ?? (e instanceof Error ? e.message : "Failed to load approvals"));
    }
  }, []);

  useEffect(() => {
    loadPending();
    const interval = setInterval(loadPending, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadPending]);

  /* --- WebSocket real-time updates --- */
  useEffect(() => {
    const newEvents = events.slice(processedCountRef.current);
    processedCountRef.current = events.length;

    for (const evt of newEvents) {
      // The server sends approve.needed as { type, request_id, session_id, request }
      // and approve.resolved as { type, request_id, session_id, decision }.
      // These don't match the WSEvent shape exactly, so we access the raw object
      // via type assertion to get the actual fields.
      const raw = evt as unknown as Record<string, unknown>;

      if (evt.type === "approve.needed") {
        const request = raw.request as Record<string, unknown> | undefined;
        const requestId = String(raw.request_id ?? "");
        if (!requestId) continue;

        const newApproval: PendingApproval = {
          request_id: requestId,
          session_id: String(request?.session_id ?? raw.session_id ?? ""),
          step_id: String(request?.step_id ?? ""),
          tool_name: String(request?.tool_name ?? "unknown"),
          permissions: Array.isArray(request?.permissions)
            ? (request.permissions as Array<{ scope: string }>)
            : [],
          created_at: String(request?.created_at ?? new Date().toISOString()),
          received_at: new Date().toISOString(),
        };

        setPending((prev) => {
          // Avoid duplicates
          if (prev.some((p) => p.request_id === newApproval.request_id)) {
            return prev;
          }
          return [...prev, newApproval];
        });
      } else if (evt.type === "approve.resolved") {
        const requestId = String(raw.request_id ?? "");
        const decision = String(raw.decision ?? "unknown");
        if (!requestId) continue;

        setPending((prev) => {
          const item = prev.find((p) => p.request_id === requestId);
          if (item) {
            // Move to history
            setHistory((h) => {
              const resolved: ResolvedApproval = {
                request_id: item.request_id,
                tool_name: item.tool_name,
                session_id: item.session_id,
                permissions: item.permissions,
                decision,
                resolved_at: new Date().toISOString(),
              };
              return [resolved, ...h].slice(0, MAX_HISTORY);
            });
          }
          return prev.filter((p) => p.request_id !== requestId);
        });
      }
    }
  }, [events]);

  /* --- Submit approval decision --- */
  const decide = useCallback(
    async (requestId: string, decision: string) => {
      setSubmittingId(requestId);
      setError(null);
      try {
        if (connected) {
          // Prefer WS for real-time response
          send({ type: "approve", request_id: requestId, decision });
        } else {
          // Fallback to REST
          await submitApproval(requestId, decision);
        }

        // Optimistically move to history
        setPending((prev) => {
          const item = prev.find((p) => p.request_id === requestId);
          if (item) {
            setHistory((h) => {
              const resolved: ResolvedApproval = {
                request_id: item.request_id,
                tool_name: item.tool_name,
                session_id: item.session_id,
                permissions: item.permissions,
                decision,
                resolved_at: new Date().toISOString(),
              };
              return [resolved, ...h].slice(0, MAX_HISTORY);
            });
          }
          return prev.filter((p) => p.request_id !== requestId);
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to submit decision");
      } finally {
        setSubmittingId(null);
      }
    },
    [connected, send],
  );

  return (
    <ApprovalsContext.Provider
      value={{
        pending,
        history,
        pendingCount: pending.length,
        decide,
        submittingId,
        error,
        clearError,
      }}
    >
      {children}
    </ApprovalsContext.Provider>
  );
}
