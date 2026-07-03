// Single client-side store. Persistable state (AppState) lives flat at the
// top level next to ephemeral UI state; PERSIST_KEYS defines what is written
// to disk (debounced ~400ms) via the preload bridge.
import { create } from "zustand";
import type { AppState, ViewId, ProactiveAlert } from "../types";
import { defaultState } from "./defaults";
import { looksLikeV1, migrateV1 } from "./migrate";
import { uid } from "../lib/util";
import { osNotify } from "../lib/notify";

export interface Toast {
  id: string;
  text: string;
  kind: "ok" | "err" | "info";
  action?: { label: string; onClick: () => void };
}

export type BootStatus = "loading" | "ready" | "storage_error";

interface EphemeralState {
  view: ViewId;
  bootStatus: BootStatus;
  bootError?: string;
  hasApiKey: boolean;
  streamingConvId: string | null;
  toasts: Toast[];
  searchOpen: boolean;
  /** "all" = Ctrl+K everything palette; "convs" = Ctrl+P recent-conversation switcher. */
  searchMode: "all" | "convs";
  settingsOpen: boolean;
  settingsTab: string;
  onboardingOpen: boolean;
  alertsOpen: boolean;
  migratedFromV1: boolean;
  portalAgentId: string | null;
}

export type Store = AppState &
  EphemeralState & {
    set: (partial: Partial<Store>) => void;
    patch: (fn: (s: Store) => Partial<Store>) => void;
    setView: (v: ViewId) => void;
    toast: (text: string, kind?: Toast["kind"], action?: Toast["action"]) => void;
    dismissToast: (id: string) => void;
    addAlert: (a: Omit<ProactiveAlert, "id" | "ts" | "read">) => void;
  };

const PERSIST_KEYS: (keyof AppState)[] = [
  "schema",
  "model",
  "maxTokens",
  "darkMode",
  "showTimestamps",
  "compactMode",
  "profile",
  "agents",
  "activeAgentId",
  "activeConvId",
  "conversations",
  "messages",
  "projects",
  "tasks",
  "recurringTasks",
  "fileKnowledge",
  "companyMemory",
  "businessProfile",
  "workspace",
  "proactiveAlerts",
  "folders",
  "artifacts",
  "settings",
  "usage",
  "_legacy",
];

export const useStore = create<Store>((set, get) => ({
  ...defaultState(),
  view: "home",
  bootStatus: "loading",
  hasApiKey: false,
  streamingConvId: null,
  toasts: [],
  searchOpen: false,
  searchMode: "all",
  settingsOpen: false,
  settingsTab: "profile",
  onboardingOpen: false,
  alertsOpen: false,
  migratedFromV1: false,
  portalAgentId: null,

  set: (partial) => set(partial),
  patch: (fn) => set((s) => fn(s)),
  setView: (v) => set({ view: v }),
  toast: (text, kind = "info", action) => {
    const t: Toast = { id: uid(), text, kind, action };
    set((s) => ({ toasts: [...s.toasts, t] }));
    window.setTimeout(() => get().dismissToast(t.id), kind === "err" ? 8000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  addAlert: (a) => {
    set((s) => ({
      proactiveAlerts: [{ ...a, id: uid(), ts: Date.now(), read: false }, ...s.proactiveAlerts].slice(0, 200),
    }));
    if (get().settings.notificationsEnabled) osNotify(a.title, a.body);
  },
}));

/** Accumulate real API token usage (reported by the API itself) into the monthly log. */
export function recordUsage(
  model: string,
  u: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number }
) {
  if (!u.in && !u.out && !u.cacheRead && !u.cacheWrite) return;
  const s = useStore.getState();
  const month = new Date().toISOString().slice(0, 7);
  const cur = s.usage[month]?.[model] ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  useStore.setState({
    usage: {
      ...s.usage,
      [month]: {
        ...(s.usage[month] ?? {}),
        [model]: {
          in: cur.in + (u.in ?? 0),
          out: cur.out + (u.out ?? 0),
          cacheRead: cur.cacheRead + (u.cacheRead ?? 0),
          cacheWrite: cur.cacheWrite + (u.cacheWrite ?? 0),
          calls: cur.calls + 1,
        },
      },
    },
  });
}

export function serializeState(s: Store): string {
  const out: Record<string, unknown> = {};
  for (const k of PERSIST_KEYS) out[k] = s[k];
  return JSON.stringify(out);
}

let saveTimer: number | undefined;
let persistenceArmed = false;

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void window.aria.store.save(serializeState(useStore.getState()));
  }, 400);
}

export function flushSave(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  return window.aria.store.save(serializeState(useStore.getState()));
}

/** Merge a loaded/imported plain object into a fresh default state (gap-fill). */
export function hydrate(data: any): AppState {
  const base = defaultState();
  const out: any = { ...base };
  for (const k of PERSIST_KEYS) {
    if (data[k] !== undefined && data[k] !== null) out[k] = data[k];
  }
  // Nested gap-fill so old v2 saves survive new fields.
  out.settings = { ...base.settings, ...(data.settings || {}) };
  out.settings.adminRules = { ...base.settings.adminRules, ...((data.settings || {}).adminRules || {}) };
  out.companyMemory = { ...base.companyMemory, ...(data.companyMemory || {}) };
  out.businessProfile = { ...base.businessProfile, ...(data.businessProfile || {}) };
  out.profile = { ...base.profile, ...(data.profile || {}) };
  out.schema = 2;
  return out as AppState;
}

/** Apply a parsed backup/import (either v1 ariaApp_v4 or v2) to the live store. */
export async function applyImport(data: any): Promise<{ migrated: boolean }> {
  // V10-era "Export backup" wrapped the state: { ariaExport, version, ts, state }.
  if (data && typeof data === "object" && data.ariaExport && data.state && typeof data.state === "object") {
    data = data.state;
  }
  if (looksLikeV1(data)) {
    const { state, secrets } = migrateV1(data);
    for (const [name, value] of Object.entries(secrets)) {
      await window.aria.secrets.set(name, value);
    }
    useStore.setState({ ...state, hasApiKey: !!secrets.anthropicApiKey || (await window.aria.secrets.has("anthropicApiKey")) });
    return { migrated: true };
  }
  useStore.setState({ ...hydrate(data) });
  return { migrated: false };
}

export async function boot(): Promise<void> {
  const st = useStore;
  try {
    const raw = await window.aria.store.load();
    if (raw && typeof raw === "object" && "__error" in raw) {
      st.setState({ bootStatus: "storage_error", bootError: raw.__error });
      return;
    }
    let migrated = false;
    if (typeof raw === "string") {
      const data = JSON.parse(raw);
      if (looksLikeV1(data)) {
        await window.aria.store.autoBackup(raw, "pre-migration");
        await applyImport(data);
        migrated = true;
      } else {
        st.setState({ ...hydrate(data) });
      }
    } else {
      // No on-disk state. The packaged app shares the file:// origin with the
      // old single-file build, so its localStorage may still hold user data.
      const legacyRaw = window.localStorage?.getItem("ariaApp_v4");
      if (legacyRaw) {
        try {
          await window.aria.store.autoBackup(legacyRaw, "pre-migration");
          await applyImport(JSON.parse(legacyRaw));
          migrated = true;
        } catch (e) {
          console.warn("Legacy migration failed:", e);
        }
      }
    }
    // Purge conversations that have sat in the trash for more than 30 days.
    {
      const cutoff = Date.now() - 30 * 864e5;
      const s0 = st.getState();
      const expired = Object.values(s0.conversations).filter((c) => c.deletedAt && c.deletedAt < cutoff);
      if (expired.length) {
        const conversations = { ...s0.conversations };
        const messages = { ...s0.messages };
        for (const c of expired) {
          delete conversations[c.id];
          delete messages[c.id];
        }
        st.setState({ conversations, messages });
      }
    }
    const hasApiKey = await window.aria.secrets.has("anthropicApiKey");
    const s = st.getState();
    st.setState({
      bootStatus: "ready",
      hasApiKey,
      migratedFromV1: migrated,
      onboardingOpen: !s.settings.onboarded,
      streamingConvId: null,
    });
    if (migrated) {
      st.getState().toast("Your existing ARIA data was imported (a backup was saved first).", "ok");
      void flushSave();
    }
    // From here on, every state change persists (debounced).
    if (!persistenceArmed) {
      persistenceArmed = true;
      useStore.subscribe(() => scheduleSave());
      window.addEventListener("beforeunload", () => {
        void flushSave();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flushSave();
      });
    }
  } catch (e: any) {
    st.setState({ bootStatus: "storage_error", bootError: String(e?.message ?? e) });
  }
}
