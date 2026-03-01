/* ── Notification Preferences (localStorage-backed) ───────────────── */

const STORAGE_KEY = "karnevil9:notification-prefs";

export interface NotificationPrefs {
  /** Map of event type -> whether toasts are enabled for that event */
  toastEvents: Record<string, boolean>;
  /** Whether to also send browser Notification API notifications */
  browserNotifications: boolean;
  /** Whether to play a subtle audio beep on notifications */
  soundEnabled: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  toastEvents: {
    "session.completed": true,
    "session.failed": true,
    "session.aborted": true,
    "approval.needed": true,
    "step.failed": false,
    "connection.lost": true,
    "connection.restored": true,
  },
  browserNotifications: false,
  soundEnabled: false,
};

/** SSR-safe check for localStorage availability */
function hasLocalStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = "__ls_test__";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Read notification preferences from localStorage (falls back to defaults). */
export function getNotificationPrefs(): NotificationPrefs {
  if (!hasLocalStorage()) return { ...DEFAULT_PREFS, toastEvents: { ...DEFAULT_PREFS.toastEvents } };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS, toastEvents: { ...DEFAULT_PREFS.toastEvents } };

    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;

    // Merge with defaults so new event keys added in future versions are included
    const toastEvents = { ...DEFAULT_PREFS.toastEvents };
    if (parsed.toastEvents && typeof parsed.toastEvents === "object") {
      for (const [key, value] of Object.entries(parsed.toastEvents)) {
        if (typeof value === "boolean") {
          toastEvents[key] = value;
        }
      }
    }

    return {
      toastEvents,
      browserNotifications:
        typeof parsed.browserNotifications === "boolean"
          ? parsed.browserNotifications
          : DEFAULT_PREFS.browserNotifications,
      soundEnabled:
        typeof parsed.soundEnabled === "boolean"
          ? parsed.soundEnabled
          : DEFAULT_PREFS.soundEnabled,
    };
  } catch {
    return { ...DEFAULT_PREFS, toastEvents: { ...DEFAULT_PREFS.toastEvents } };
  }
}

/** Persist notification preferences to localStorage. */
export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or unavailable -- silently ignore
  }
}

/** Reset preferences to defaults and persist. */
export function resetToDefaults(): NotificationPrefs {
  const prefs: NotificationPrefs = {
    ...DEFAULT_PREFS,
    toastEvents: { ...DEFAULT_PREFS.toastEvents },
  };
  saveNotificationPrefs(prefs);
  return prefs;
}
