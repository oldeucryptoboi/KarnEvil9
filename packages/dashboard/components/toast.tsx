"use client";

import {
  createContext,
  useContext,
  useCallback,
  useState,
  useRef,
  useEffect,
  type ReactNode,
} from "react";

/* ---------- Types ---------- */

export type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  /** Whether the toast is currently visible (used for fade-in) */
  visible: boolean;
}

interface ToastContextValue {
  addToast: (message: string, type: ToastType, duration?: number) => void;
}

/* ---------- Context ---------- */

const ToastContext = createContext<ToastContextValue>({
  addToast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/* ---------- Constants ---------- */

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 5000;

/* ---------- Color map ---------- */

const borderColorMap: Record<ToastType, string> = {
  success: "border-l-green-500",
  error: "border-l-red-500",
  warning: "border-l-yellow-500",
  info: "border-l-blue-500",
};

const iconMap: Record<ToastType, string> = {
  success: "\u2713",
  error: "\u2717",
  warning: "\u26A0",
  info: "\u2139",
};

const iconColorMap: Record<ToastType, string> = {
  success: "text-green-500",
  error: "text-red-500",
  warning: "text-yellow-500",
  info: "text-blue-500",
};

/* ---------- Provider ---------- */

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** Clean up all timers on unmount */
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType, duration: number = DEFAULT_DURATION) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setToasts((prev) => {
        // If we are at capacity, drop the oldest toast(s)
        let next = [...prev];
        while (next.length >= MAX_TOASTS) {
          const oldest = next[0];
          if (oldest) {
            const timer = timersRef.current.get(oldest.id);
            if (timer) {
              clearTimeout(timer);
              timersRef.current.delete(oldest.id);
            }
          }
          next = next.slice(1);
        }
        return [...next, { id, message, type, visible: false }];
      });

      // Trigger visibility on the next frame so the CSS transition fires
      requestAnimationFrame(() => {
        setToasts((prev) =>
          prev.map((t) => (t.id === id ? { ...t, visible: true } : t)),
        );
      });

      // Auto-dismiss
      const timer = setTimeout(() => removeToast(id), duration);
      timersRef.current.set(id, timer);
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

/* ---------- Container ---------- */

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            "pointer-events-auto",
            "bg-[var(--card)] border border-[var(--border)] rounded-lg px-4 py-3 shadow-lg",
            "border-l-4",
            borderColorMap[toast.type],
            "flex items-start gap-3 min-w-[300px] max-w-[420px]",
            "transition-all duration-300 ease-out",
            toast.visible
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-2",
          ].join(" ")}
          role="alert"
        >
          <span className={`text-sm font-bold mt-0.5 ${iconColorMap[toast.type]}`}>
            {iconMap[toast.type]}
          </span>
          <p className="text-sm text-[var(--foreground)] flex-1 break-words">
            {toast.message}
          </p>
          <button
            onClick={() => onDismiss(toast.id)}
            className="text-[var(--muted)] hover:text-[var(--foreground)] transition-colors text-sm leading-none ml-2 mt-0.5"
            aria-label="Dismiss"
          >
            &#x2715;
          </button>
        </div>
      ))}
    </div>
  );
}
