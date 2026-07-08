// Typing for the preload bridge (window.aria).
export interface StreamHandlers {
  onChunk?: (raw: string) => void;
  onDone?: () => void;
  onAborted?: () => void;
  onError?: (err: { message: string; status?: number }) => void;
}

export interface AriaBridge {
  store: {
    load: () => Promise<string | null | { __error: string }>;
    save: (json: string) => Promise<boolean>;
    wipe: () => Promise<boolean>;
    autoBackup: (json: string, label?: string) => Promise<string>;
    exportBackup: (json: string, defaultName?: string) => Promise<string | null>;
    importBackup: () => Promise<string | null>;
    restoreLatestBackup?: () => Promise<{ ok: true; name: string } | { ok: false; error: string }>;
    replaceFromFile?: () => Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  };
  secrets: {
    set: (name: string, value: string) => Promise<boolean>;
    has: (name: string) => Promise<boolean>;
    preview: (name: string) => Promise<string | null>;
  };
  api: {
    stream: (payload: unknown, handlers: StreamHandlers) => string;
    abort: (id: string) => Promise<boolean>;
    call: (payload: unknown) => Promise<
      { ok: true; data: any } | { ok: false; error: string; status?: number }
    >;
  };
  net: {
    fetchText: (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => Promise<{ ok: boolean; status?: number; text?: string; error?: string }>;
  };
  stt: {
    transcribe: (
      audioBuffer: ArrayBuffer,
      mimeType: string
    ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  };
  updates?: {
    onEvent: (cb: (payload: { type: "available" | "downloaded"; info: { version: string } }) => void) => void;
    install: () => Promise<void>;
    check?: () => Promise<
      | { ok: true; current: string; latest: string | null; updateAvailable: boolean }
      | { ok: false; error?: string }
    >;
  };
  app: {
    info: () => Promise<{ version: string; platform: string; userData: string; packaged: boolean }>;
    openExternal: (url: string) => Promise<void>;
    setCloseToTray: (on: boolean) => Promise<boolean>;
    setTrayTooltip: (text: string) => Promise<boolean>;
    openBackups?: () => Promise<string>;
    exportPdf?: (html: string, title: string) => Promise<string | null | { __error: string }>;
  };
}

declare global {
  interface Window {
    aria: AriaBridge;
  }
}

export {};
