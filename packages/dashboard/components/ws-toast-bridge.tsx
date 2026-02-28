"use client";

import { useEffect, useRef } from "react";
import { useWSContext } from "@/lib/ws-context";
import { useToast } from "@/components/toast";

/**
 * Bridge component that listens to WebSocket events and fires toast
 * notifications for key session lifecycle events and connection changes.
 *
 * Must be rendered inside both WSProvider and ToastProvider.
 */
export function WSToastBridge() {
  const { events, connected } = useWSContext();
  const { addToast } = useToast();

  // Track how many events we have already processed so we only toast new ones
  const processedCountRef = useRef(0);

  // Track previous connection state to detect transitions
  const prevConnectedRef = useRef<boolean | null>(null);

  /* --- Handle session lifecycle events --- */
  useEffect(() => {
    const newEvents = events.slice(processedCountRef.current);
    processedCountRef.current = events.length;

    for (const evt of newEvents) {
      const shortId = evt.session_id?.slice(0, 8) ?? "unknown";

      switch (evt.type) {
        case "session.completed":
          addToast(`Session ${shortId}... completed`, "success");
          break;
        case "session.failed":
          addToast(`Session ${shortId}... failed`, "error");
          break;
        case "session.aborted":
          addToast(`Session ${shortId}... aborted`, "warning");
          break;
        default:
          break;
      }
    }
  }, [events, addToast]);

  /* --- Handle connection state changes --- */
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = connected;

    // Skip the initial mount (prev is null)
    if (prev === null) return;

    if (!connected && prev) {
      addToast("WebSocket disconnected", "warning");
    } else if (connected && !prev) {
      addToast("WebSocket reconnected", "success");
    }
  }, [connected, addToast]);

  // This component renders nothing
  return null;
}
