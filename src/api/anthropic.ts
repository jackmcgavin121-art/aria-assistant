// Anthropic Messages API client. All network I/O happens in the Electron main
// process (no CORS hacks); this module speaks the preload bridge and parses SSE.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StreamRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: ApiMessage[];
  tools?: ToolDef[];
}

/**
 * Large system prompts (business context + injected knowledge) are marked for
 * prompt caching — repeated turns in an active chat then reuse the cached
 * prefix instead of re-processing it, cutting cost and latency.
 */
function systemParam(system: string) {
  if (!system) return undefined;
  if (system.length >= 4096) {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return system;
}

export interface StreamCallbacks {
  onText: (delta: string, full: string) => void;
  onDone: (full: string) => void;
  onError: (message: string) => void;
  onAborted?: (partial: string) => void;
}

export interface StreamHandle {
  abort: () => void;
}

/** Incremental SSE parser: feed raw chunks, emits parsed event payloads. */
class SseParser {
  private buf = "";
  feed(chunk: string, onEvent: (data: any) => void) {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) {
          const json = line.slice(5).trim();
          if (!json || json === "[DONE]") continue;
          try {
            onEvent(JSON.parse(json));
          } catch {
            /* partial/keepalive line — ignore */
          }
        }
      }
    }
  }
}

export function streamCompletion(req: StreamRequest, cb: StreamCallbacks): StreamHandle {
  const parser = new SseParser();
  let full = "";
  let errored = false;

  const id = window.aria.api.stream(
    {
      model: req.model,
      max_tokens: req.maxTokens,
      system: systemParam(req.system),
      messages: req.messages,
    },
    {
      onChunk: (raw: string) => {
        parser.feed(raw, (ev) => {
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            full += ev.delta.text;
            cb.onText(ev.delta.text, full);
          } else if (ev.type === "error") {
            errored = true;
            cb.onError(ev.error?.message || "Stream error");
          }
        });
      },
      onDone: () => {
        if (!errored) cb.onDone(full);
      },
      onAborted: () => cb.onAborted?.(full),
      onError: (err) => {
        errored = true;
        cb.onError(err?.message || "Request failed");
      },
    }
  );

  return { abort: () => void window.aria.api.abort(id) };
}

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

/** Non-streaming call used by agent task execution and the autonomy loop. */
export async function completeOnce(
  req: StreamRequest
): Promise<{ ok: true; text: string; toolUses: ToolUse[] } | { ok: false; error: string }> {
  const res = await window.aria.api.call({
    model: req.model,
    max_tokens: req.maxTokens,
    system: systemParam(req.system),
    messages: req.messages,
    tools: req.tools,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const blocks: any[] = res.data?.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolUses: ToolUse[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ name: b.name, input: b.input ?? {} }));
  return { ok: true, text, toolUses };
}

/**
 * Streaming variant for agent task execution: reports honest progress by
 * characters streamed so far.
 */
export function streamOnce(
  req: StreamRequest,
  onProgress: (chars: number) => void
): Promise<{ ok: true; text: string } | { ok: false; error: string; partial?: string }> {
  return new Promise((resolve) => {
    streamCompletion(req, {
      onText: (_d, full) => onProgress(full.length),
      onDone: (full) => resolve({ ok: true, text: full }),
      onAborted: (partial) => resolve({ ok: false, error: "Aborted", partial }),
      onError: (message) => resolve({ ok: false, error: message }),
    });
  });
}
