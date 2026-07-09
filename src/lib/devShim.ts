// DEV-ONLY fallback bridge, installed when the app runs in a plain browser
// (vite dev server opened outside Electron). The packaged desktop app always
// has the real preload bridge with encrypted secrets and main-process I/O.
// Here: state → localStorage, secrets → localStorage (plaintext, dev only),
// API calls → direct browser fetch (Anthropic's dev-only browser access flag).
import type { AriaBridge, StreamHandlers } from "../bridge.d";

const STATE_KEY = "ariaDevState_v2";
const SECRETS_KEY = "ariaDevSecrets";

function secrets(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SECRETS_KEY) || "{}");
  } catch {
    return {};
  }
}

const aborters = new Map<string, AbortController>();
let seq = 0;

async function doStream(payload: any, h: StreamHandlers): Promise<void> {
  const key = secrets().anthropicApiKey;
  if (!key) {
    h.onError?.({ message: "No API key set. Add your Anthropic API key in Settings → AI & API." });
    return;
  }
  const id = "dev" + ++seq;
  const ac = new AbortController();
  aborters.set(id, ac);
  (doStream as any).lastId = id;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ac.signal,
    });
    if (!res.ok) {
      h.onError?.({ status: res.status, message: `API error (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}` });
      return;
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      h.onChunk?.(dec.decode(value, { stream: true }));
    }
    h.onDone?.();
  } catch (e: any) {
    if (e.name === "AbortError") h.onAborted?.();
    else h.onError?.({ message: String(e?.message ?? e) });
  } finally {
    aborters.delete(id);
  }
}

export function installDevShim() {
  if (window.aria) return;
  console.warn("[ARIA] Running without the Electron shell — using the DEV browser bridge (localStorage persistence, plaintext dev secrets).");
  const bridge: AriaBridge = {
    store: {
      load: async () => localStorage.getItem(STATE_KEY),
      save: async (json) => {
        localStorage.setItem(STATE_KEY, json);
        return true;
      },
      wipe: async () => {
        localStorage.removeItem(STATE_KEY);
        localStorage.removeItem(SECRETS_KEY);
        return true;
      },
      autoBackup: async () => "(dev: backup skipped)",
      exportBackup: async (json, defaultName) => {
        const blob = new Blob([json], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = defaultName || "aria-backup.json";
        a.click();
        return "download";
      },
      importBackup: async () =>
        new Promise((resolve) => {
          const inp = document.createElement("input");
          inp.type = "file";
          inp.accept = ".json";
          inp.onchange = async () => resolve(inp.files?.[0] ? await inp.files[0].text() : null);
          inp.click();
        }),
    },
    secrets: {
      set: async (name, value) => {
        const s = secrets();
        if (value) s[name] = value;
        else delete s[name];
        localStorage.setItem(SECRETS_KEY, JSON.stringify(s));
        return true;
      },
      has: async (name) => !!secrets()[name],
      preview: async (name) => {
        const v = secrets()[name];
        return v ? `${v.slice(0, 7)}…${v.slice(-4)}` : null;
      },
    },
    cloudSession: {
      get: async () => secrets().cloudSession ?? null,
      set: async (value) => {
        const s = secrets();
        if (value) s.cloudSession = value;
        else delete s.cloudSession;
        localStorage.setItem(SECRETS_KEY, JSON.stringify(s));
        return true;
      },
    },
    api: {
      stream: (payload, handlers) => {
        void doStream(payload, handlers);
        return (doStream as any).lastId ?? "dev0";
      },
      abort: async (id) => {
        aborters.get(id)?.abort();
        return true;
      },
      call: async (payload) => {
        const key = secrets().anthropicApiKey;
        if (!key) return { ok: false as const, error: "No API key set." };
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({ ...(payload as object), stream: false }),
          });
          const text = await res.text();
          if (!res.ok) return { ok: false as const, error: `API error (HTTP ${res.status})`, status: res.status };
          return { ok: true as const, data: JSON.parse(text) };
        } catch (e: any) {
          return { ok: false as const, error: String(e?.message ?? e) };
        }
      },
    },
    net: {
      fetchText: async (url, init) => {
        try {
          const res = await fetch(url, init as RequestInit);
          return { ok: res.ok, status: res.status, text: await res.text() };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },
    },
    stt: {
      transcribe: async (audioBuffer, mimeType) => {
        const key = secrets().openaiApiKey;
        if (!key) return { ok: false as const, error: "No OpenAI API key set (Settings → Voice)." };
        try {
          const form = new FormData();
          form.append("file", new Blob([audioBuffer], { type: mimeType }), "audio.webm");
          form.append("model", "whisper-1");
          const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: "Bearer " + key },
            body: form,
          });
          if (!res.ok) return { ok: false as const, error: `Whisper error (HTTP ${res.status})` };
          return { ok: true as const, text: (await res.json()).text || "" };
        } catch (e: any) {
          return { ok: false as const, error: String(e?.message ?? e) };
        }
      },
    },
    app: {
      info: async () => ({ version: "dev", platform: "browser", userData: "(localStorage)", packaged: false }),
      openExternal: async (url) => {
        window.open(url, "_blank", "noopener");
      },
      setCloseToTray: async () => true,
      setTrayTooltip: async () => true,
    },
  };
  (window as any).aria = bridge;
}
