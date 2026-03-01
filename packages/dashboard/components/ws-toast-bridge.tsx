"use client";

import { useEffect, useRef, useCallback } from "react";
import { useWSContext } from "@/lib/ws-context";
import { useToast } from "@/components/toast";
import { getNotificationPrefs } from "@/lib/notification-prefs";
import type { NotificationPrefs } from "@/lib/notification-prefs";

/**
 * Bridge component that listens to WebSocket events and fires toast
 * notifications for key session lifecycle events, approval requests,
 * and connection changes.
 *
 * Respects user notification preferences stored in localStorage.
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

  /** Read current prefs fresh each time (they may change from the settings page). */
  const getPrefs = useCallback((): NotificationPrefs => {
    return getNotificationPrefs();
  }, []);

  /** Play a subtle notification beep using Web Audio API. */
  const playNotificationSound = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.connect(gain);
      gain.connect(ctx.destination);

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.2);

      // Clean up the AudioContext after the beep finishes
      setTimeout(() => {
        ctx.close().catch(() => {});
      }, 300);
    } catch {
      // Web Audio not available -- silently skip
    }
  }, []);

  /** Send a browser Notification if enabled and permission is granted. */
  const sendBrowserNotification = useCallback(
    (title: string, body: string) => {
      if (
        typeof window === "undefined" ||
        typeof Notification === "undefined"
      )
        return;
      if (Notification.permission !== "granted") return;

      try {
        new Notification(title, {
          body,
          icon: "/favicon.ico",
          tag: `karnevil9-${Date.now()}`,
        });
      } catch {
        // Notification API not available or blocked
      }
    },
    [],
  );

  /** Shared helper: fire toast + optionally browser notification + sound. */
  const notify = useCallback(
    (
      eventType: string,
      message: string,
      toastType: "success" | "error" | "warning" | "info",
      duration?: number,
    ) => {
      const prefs = getPrefs();

      // Check if this event type is enabled for toasts
      if (prefs.toastEvents[eventType] === false) return;

      addToast(message, toastType, duration);

      if (prefs.browserNotifications) {
        sendBrowserNotification("KarnEvil9", message);
      }

      if (prefs.soundEnabled) {
        playNotificationSound();
      }
    },
    [getPrefs, addToast, sendBrowserNotification, playNotificationSound],
  );

  /* --- Handle session lifecycle events --- */
  useEffect(() => {
    const newEvents = events.slice(processedCountRef.current);
    processedCountRef.current = events.length;

    for (const evt of newEvents) {
      const shortId = evt.session_id?.slice(0, 8) ?? "unknown";

      switch (evt.type) {
        case "session.completed":
          notify(
            "session.completed",
            `Session ${shortId}... completed`,
            "success",
          );
          break;
        case "session.failed":
          notify(
            "session.failed",
            `Session ${shortId}... failed`,
            "error",
          );
          break;
        case "session.aborted":
          notify(
            "session.aborted",
            `Session ${shortId}... aborted`,
            "warning",
          );
          break;
        case "approve.needed": {
          const raw = evt as unknown as Record<string, unknown>;
          const request = raw.request as
            | Record<string, unknown>
            | undefined;
          const toolName = String(request?.tool_name ?? "unknown");
          notify(
            "approval.needed",
            `Approval needed: ${toolName}`,
            "warning",
            8000,
          );
          break;
        }
        case "step.failed":
          notify(
            "step.failed",
            `Step failed in session ${shortId}...`,
            "error",
          );
          break;
        default:
          break;
      }
    }
  }, [events, notify]);

  /* --- Handle connection state changes --- */
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = connected;

    // Skip the initial mount (prev is null)
    if (prev === null) return;

    if (!connected && prev) {
      notify("connection.lost", "WebSocket disconnected", "warning");
    } else if (connected && !prev) {
      notify(
        "connection.restored",
        "WebSocket reconnected",
        "success",
      );
    }
  }, [connected, notify]);

  // This component renders nothing
  return null;
}
