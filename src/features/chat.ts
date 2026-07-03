// Chat engine: conversation CRUD + streaming send/stop/regenerate.
import { useStore } from "../store/store";
import type { Conversation, Message, Agent } from "../types";
import { uid } from "../lib/util";
import { buildSystemPrompt } from "../api/systemPrompt";
import { streamCompletion, completeOnce, type StreamHandle, type ApiMessage } from "../api/anthropic";
import { speak } from "../lib/tts";
import { markdownToText } from "../lib/markdown";

let currentStream: StreamHandle | null = null;

export function getAgent(id?: string | null): Agent | null {
  const s = useStore.getState();
  return s.agents.find((a) => a.id === (id ?? s.activeAgentId)) ?? null;
}

export function newConversation(opts: Partial<Conversation> = {}): Conversation {
  const s = useStore.getState();
  const conv: Conversation = {
    title: "New conversation",
    agentId: opts.agentId !== undefined ? opts.agentId : s.activeAgentId,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...opts,
    id: opts.id ?? uid(),
  } as Conversation;
  useStore.setState({
    conversations: { ...s.conversations, [conv.id]: conv },
    messages: { ...s.messages, [conv.id]: s.messages[conv.id] ?? [] },
    activeConvId: conv.id,
    view: "chat",
  });
  return conv;
}

export function openConversation(id: string) {
  const s = useStore.getState();
  if (!s.conversations[id]) return;
  useStore.setState({
    activeConvId: id,
    activeAgentId: s.conversations[id].agentId ?? s.activeAgentId,
    view: "chat",
  });
}

export function renameConversation(id: string, title: string) {
  const s = useStore.getState();
  const c = s.conversations[id];
  if (!c) return;
  useStore.setState({ conversations: { ...s.conversations, [id]: { ...c, title } } });
}

export function togglePin(id: string) {
  const s = useStore.getState();
  const c = s.conversations[id];
  if (!c) return;
  useStore.setState({ conversations: { ...s.conversations, [id]: { ...c, pinned: !c.pinned } } });
}

export function setConvFolder(id: string, folderId?: string) {
  const s = useStore.getState();
  const c = s.conversations[id];
  if (!c) return;
  useStore.setState({ conversations: { ...s.conversations, [id]: { ...c, folderId } } });
}

/** Soft delete: moves to trash (purged after 30 days), with an Undo toast. */
export function deleteConversation(id: string) {
  const s = useStore.getState();
  const c = s.conversations[id];
  if (!c) return;
  useStore.setState({
    conversations: { ...s.conversations, [id]: { ...c, deletedAt: Date.now() } },
    activeConvId: s.activeConvId === id ? null : s.activeConvId,
  });
  s.toast("Conversation moved to trash", "info", {
    label: "Undo",
    onClick: () => restoreConversation(id),
  });
}

export function restoreConversation(id: string) {
  const s = useStore.getState();
  const c = s.conversations[id];
  if (!c) return;
  const { deletedAt: _gone, ...rest } = c;
  useStore.setState({ conversations: { ...s.conversations, [id]: rest as Conversation } });
}

/** Permanent removal (empty trash / delete forever). */
export function purgeConversation(id: string) {
  const s = useStore.getState();
  const conversations = { ...s.conversations };
  const messages = { ...s.messages };
  delete conversations[id];
  delete messages[id];
  useStore.setState({
    conversations,
    messages,
    activeConvId: s.activeConvId === id ? null : s.activeConvId,
  });
}

/** Fork a conversation: copy everything up to and including the given message. */
export function branchConversation(convId: string, msgId: string) {
  const s = useStore.getState();
  const conv = s.conversations[convId];
  const list = s.messages[convId] ?? [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (!conv || idx < 0) return;
  const fresh = newConversation({
    agentId: conv.agentId,
    projectId: conv.projectId,
    folderId: conv.folderId,
    title: conv.title.replace(/ \(branch\)$/, "").slice(0, 50) + " (branch)",
  });
  const st = useStore.getState();
  useStore.setState({
    messages: { ...st.messages, [fresh.id]: list.slice(0, idx + 1).map((m) => ({ ...m, id: uid() })) },
  });
  s.toast("Branched into a new conversation", "ok");
}

function pushMessage(convId: string, msg: Message) {
  const s = useStore.getState();
  useStore.setState({
    messages: { ...s.messages, [convId]: [...(s.messages[convId] ?? []), msg] },
    conversations: {
      ...s.conversations,
      [convId]: { ...s.conversations[convId], updatedAt: Date.now() },
    },
  });
}

function updateLastAssistant(convId: string, patch: Partial<Message>) {
  const s = useStore.getState();
  const list = s.messages[convId] ?? [];
  if (!list.length) return;
  const idx = list.length - 1;
  if (list[idx].role !== "assistant") return;
  const next = [...list];
  next[idx] = { ...next[idx], ...patch };
  useStore.setState({ messages: { ...s.messages, [convId]: next } });
}

function historyToApi(convId: string, limit = 40): { role: "user" | "assistant"; content: string }[] {
  const s = useStore.getState();
  const list = (s.messages[convId] ?? []).slice(-limit);
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of list) {
    const content = m.content.trim();
    if (!content) continue;
    // API requires alternating roles; merge consecutive same-role messages.
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += "\n\n" + content;
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

/** Detect explicit "remember this" / correction phrasing → learning log. */
export function detectLearningSignals(userText: string) {
  const s = useStore.getState();
  const t = userText.trim();
  let source: "explicit" | "correction" | null = null;
  let text = "";
  const remember = t.match(/^(?:aria,?\s*)?(?:please\s+)?remember\s*[:,-]?\s*(.{4,})/i);
  const correction = t.match(/^(?:actually|no[,.]?\s|that'?s (?:wrong|incorrect))\s*[:,-]?\s*(.{4,})/i);
  if (remember) {
    source = "explicit";
    text = remember[1];
  } else if (correction) {
    source = "correction";
    text = t;
  }
  if (!source) return;
  useStore.setState({
    companyMemory: {
      ...s.companyMemory,
      learningLog: [
        { id: uid(), text: text.trim(), source, ts: Date.now(), promoted: false },
        ...s.companyMemory.learningLog,
      ].slice(0, 300),
    },
  });
  s.toast("Noted in the learning log", "ok");
}

export function isStreaming(): boolean {
  return !!useStore.getState().streamingConvId;
}

export function stopStreaming() {
  currentStream?.abort();
}

export interface SendOptions {
  convId?: string;
  agentId?: string | null;
  attachmentText?: string;
  attachmentMeta?: Message["attachments"];
  images?: { mediaType: string; base64: string }[];
  /** Pre-flight replacement for the API content of the last user message (web research). */
  apiContentOverride?: string;
  webSources?: Message["webSources"];
}

export async function sendMessage(text: string, opts: SendOptions = {}): Promise<void> {
  const store = useStore;
  let s = store.getState();
  if (s.streamingConvId) return;
  if (!s.hasApiKey) {
    s.toast("Add your Anthropic API key in Settings → AI & API first.", "err", {
      label: "Open Settings",
      onClick: () => store.setState({ settingsOpen: true, settingsTab: "ai" }),
    });
    return;
  }

  const convId = opts.convId ?? s.activeConvId ?? newConversation({ agentId: opts.agentId ?? s.activeAgentId }).id;
  s = store.getState();
  const conv = s.conversations[convId];
  const agent = getAgent(opts.agentId !== undefined ? opts.agentId : conv.agentId);

  detectLearningSignals(text);

  // Keep attachment content with the message so edit & resend / regenerate
  // can honestly re-send it (images only when small enough to persist sanely).
  const imagesSize = (opts.images ?? []).reduce((n, im) => n + im.base64.length, 0);
  const userMsg: Message = {
    id: uid(),
    role: "user",
    content: text,
    ts: Date.now(),
    attachments: opts.attachmentMeta,
    attachmentText: opts.attachmentText?.slice(0, 300_000),
    images: opts.images?.length && imagesSize <= 1_500_000 ? opts.images : undefined,
    webSources: opts.webSources,
  };
  pushMessage(convId, userMsg);

  // Auto-title from the first user message.
  if ((s.messages[convId] ?? []).length === 0 || conv.title === "New conversation") {
    renameConversation(convId, text.slice(0, 48) + (text.length > 48 ? "…" : ""));
  }

  const { system, truncatedDocs } = buildSystemPrompt(store.getState(), agent, conv, text);
  if (truncatedDocs.length) {
    s.toast(`Knowledge truncated to fit context: ${truncatedDocs.slice(0, 3).join(", ")}${truncatedDocs.length > 3 ? "…" : ""}`, "info");
  }

  const apiMessages: ApiMessage[] = historyToApi(convId);
  // Attachment text and research context ride along on the final user turn only.
  const finalContent =
    (opts.apiContentOverride ?? text) +
    (opts.attachmentText ? `\n\n[Attached document content]\n${opts.attachmentText}` : "");
  const finalBlock: ApiMessage["content"] = opts.images?.length
    ? [
        ...opts.images.map((im) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: im.mediaType, data: im.base64 },
        })),
        { type: "text" as const, text: finalContent },
      ]
    : finalContent;
  if (apiMessages.length) apiMessages[apiMessages.length - 1].content = finalBlock;
  else apiMessages.push({ role: "user", content: finalBlock });

  const model = agent?.model || s.model;
  const assistantMsg: Message = {
    id: uid(),
    role: "assistant",
    content: "",
    ts: Date.now(),
    agentId: agent?.id,
    model,
    webSources: opts.webSources,
  };
  pushMessage(convId, assistantMsg);
  store.setState({ streamingConvId: convId });

  await new Promise<void>((resolve) => {
    currentStream = streamCompletion(
      { model, maxTokens: s.maxTokens, system, messages: apiMessages },
      {
        onText: (_delta, full) => updateLastAssistant(convId, { content: full }),
        onDone: (full, usage) => {
          if (usage) {
            updateLastAssistant(convId, {
              tokens: { in: usage.in + usage.cacheRead + usage.cacheWrite, out: usage.out },
            });
          }
          store.setState({ streamingConvId: null });
          currentStream = null;
          const st = store.getState();
          if (st.settings.ttsEnabled) speak(markdownToText(full), st.settings.ttsVoice, st.settings.ttsRate);
          void autoTitleConversation(convId, text, full);
          resolve();
        },
        onAborted: (partial) => {
          updateLastAssistant(convId, { content: partial, stopped: true });
          store.setState({ streamingConvId: null });
          currentStream = null;
          resolve();
        },
        onError: (message) => {
          updateLastAssistant(convId, {
            content: `**Error:** ${message}\n\nCheck your API key in Settings → AI & API.`,
          });
          store.setState({ streamingConvId: null });
          currentStream = null;
          store.getState().toast(message, "err");
          resolve();
        },
      }
    );
  });
}

/** Name the conversation properly after the first exchange (one cheap Haiku call). */
async function autoTitleConversation(convId: string, userText: string, reply: string) {
  const s = useStore.getState();
  const conv = s.conversations[convId];
  if (!conv || (s.messages[convId] ?? []).length !== 2) return;
  const res = await completeOnce({
    model: "claude-haiku-4-5-20251001",
    maxTokens: 30,
    system: "",
    messages: [
      {
        role: "user",
        content: `Write a 3-6 word title for this conversation. Reply with ONLY the title — no quotes, no trailing punctuation.\n\nUSER: ${userText.slice(0, 500)}\n\nASSISTANT: ${reply.slice(0, 500)}`,
      },
    ],
  });
  if (res.ok) {
    const t = res.text.trim().replace(/^["'\s]+|["'.\s]+$/g, "").slice(0, 60);
    if (t) renameConversation(convId, t);
  }
}

/** Summarize a long conversation and continue in a fresh one with the context carried over. */
export async function summarizeAndContinue(convId: string): Promise<void> {
  const s = useStore.getState();
  const conv = s.conversations[convId];
  const msgs = s.messages[convId] ?? [];
  if (!conv || msgs.length < 4 || !s.hasApiKey) {
    s.toast(msgs.length < 4 ? "This conversation is short enough to continue as-is." : "Add your API key first.", "info");
    return;
  }
  s.toast("Summarising conversation…", "info");
  const transcript = msgs.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n").slice(-40_000);
  const res = await completeOnce({
    model: s.model,
    maxTokens: 800,
    system: "",
    messages: [
      {
        role: "user",
        content: `Summarise this conversation into a compact context brief: goals, key facts and decisions, current state, and open items. Markdown bullets, no preamble.\n\n${transcript}`,
      },
    ],
  });
  if (!res.ok) {
    s.toast("Summarise failed: " + res.error, "err");
    return;
  }
  const fresh = newConversation({
    agentId: conv.agentId,
    projectId: conv.projectId,
    title: conv.title.replace(/ \(cont\.\)$/, "") + " (cont.)",
  });
  const st = useStore.getState();
  useStore.setState({
    messages: {
      ...st.messages,
      [fresh.id]: [
        { id: uid(), role: "user", content: `**Context carried over from "${conv.title}":**\n\n${res.text}`, ts: Date.now() },
        { id: uid(), role: "assistant", content: "Got it — I have the context. Where do you want to pick up?", ts: Date.now(), agentId: conv.agentId ?? undefined },
      ],
    },
  });
}

/** Remove the last assistant reply and re-send the preceding user message. */
export async function regenerateLast(convId: string): Promise<void> {
  const store = useStore;
  const s = store.getState();
  if (s.streamingConvId) return;
  const list = s.messages[convId] ?? [];
  let ai = list.length - 1;
  while (ai >= 0 && list[ai].role !== "assistant") ai--;
  if (ai <= 0) return;
  const userMsg = list[ai - 1];
  if (userMsg.role !== "user") return;
  store.setState({
    messages: { ...s.messages, [convId]: list.slice(0, ai - 1) },
  });
  await sendMessage(userMsg.content, {
    convId,
    attachmentMeta: userMsg.attachments,
    attachmentText: userMsg.attachmentText,
    images: userMsg.images,
  });
}

export function rateMessage(convId: string, msgId: string, rating: 1 | -1) {
  const s = useStore.getState();
  const list = s.messages[convId] ?? [];
  useStore.setState({
    messages: {
      ...s.messages,
      [convId]: list.map((m) =>
        m.id === msgId ? { ...m, rating: m.rating === rating ? undefined : rating } : m
      ),
    },
  });
}

/** Lightweight keyword matching to suggest the best-fitting specialist. */
const SUGGEST_RULES: { pattern: RegExp; roles: string[] }[] = [
  { pattern: /\b(sales|proposal|pitch|deal|prospect|quota|crm|lead)\b/i, roles: ["Sales"] },
  { pattern: /\b(hire|hiring|interview|onboard|employee|hr|performance review|job description)\b/i, roles: ["Human Resources"] },
  { pattern: /\b(budget|cash ?flow|p&l|forecast|invoice|finance|financial|valuation)\b/i, roles: ["Finance", "Accounting"] },
  { pattern: /\b(contract|legal|nda|terms|liability|compliance|gdpr)\b/i, roles: ["Legal"] },
  { pattern: /\b(customer|churn|renewal|nps|support ticket|onboarding guide)\b/i, roles: ["Customer Success"] },
  { pattern: /\b(code|bug|api|database|deploy|software|app|frontend|backend)\b/i, roles: ["Engineering"] },
  { pattern: /\b(process|sop|logistics|workflow|supply|inventory|operations)\b/i, roles: ["Operations", "Supply Chain"] },
  { pattern: /\b(marketing|campaign|seo|brand|social media|content|newsletter)\b/i, roles: ["Marketing", "Content"] },
  { pattern: /\b(strategy|board|investor|vision|competitive|m&a)\b/i, roles: ["C-Suite / Executive"] },
  { pattern: /\b(project plan|milestone|gantt|deadline|raci)\b/i, roles: ["Project Management"] },
];

export function suggestAgent(text: string): Agent | null {
  const s = useStore.getState();
  for (const rule of SUGGEST_RULES) {
    if (rule.pattern.test(text)) {
      const hit = s.agents.find((a) => rule.roles.some((r) => a.role.toLowerCase().includes(r.toLowerCase())));
      if (hit && hit.id !== s.activeAgentId) return hit;
    }
  }
  return null;
}
