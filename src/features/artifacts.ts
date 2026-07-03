// Artifact generation from chat + export helpers (.md/.txt/.html/.doc).
import { useStore } from "../store/store";
import type { Artifact } from "../types";
import { uid } from "../lib/util";
import { completeOnce } from "../api/anthropic";
import { buildSystemPrompt } from "../api/systemPrompt";
import { renderMarkdown } from "../lib/markdown";
import { downloadText } from "../lib/download";

export const ARTIFACT_TYPES = [
  { id: "report", icon: "📊", name: "Business report", prompt: "a structured business report with an executive summary, findings, analysis and recommendations" },
  { id: "proposal", icon: "🤝", name: "Proposal", prompt: "a client-ready proposal with overview, scope, deliverables, timeline and pricing placeholders" },
  { id: "deck", icon: "🖥️", name: "Pitch deck outline", prompt: "a slide-by-slide pitch deck outline (## = one slide) with speaker notes" },
  { id: "email", icon: "✉️", name: "Email draft", prompt: "a polished, ready-to-send email draft with subject line" },
  { id: "sop", icon: "📋", name: "SOP / process doc", prompt: "a step-by-step standard operating procedure with prerequisites, steps, and checks" },
  { id: "memo", icon: "📝", name: "Memo", prompt: "a concise internal memo with context, decision and next steps" },
  { id: "plan", icon: "🗓", name: "Project plan", prompt: "a project plan with phases, milestones, owners and risks" },
  { id: "jd", icon: "👥", name: "Job description", prompt: "a complete job description with responsibilities, requirements and benefits sections" },
  { id: "faq", icon: "❓", name: "FAQ", prompt: "a customer-facing FAQ with clear question/answer pairs" },
  { id: "summary", icon: "🧾", name: "Meeting summary", prompt: "a meeting summary with decisions, action items (owner + due), and open questions" },
];

/** Generate an artifact from the active conversation's content. */
export async function generateArtifact(typeId: string): Promise<Artifact | null> {
  const s = useStore.getState();
  const type = ARTIFACT_TYPES.find((t) => t.id === typeId);
  const convId = s.activeConvId;
  if (!type || !convId || !s.hasApiKey) {
    s.toast(!s.hasApiKey ? "Add your API key first." : "Open a conversation first — artifacts are built from its content.", "err");
    return null;
  }
  const conv = s.conversations[convId];
  const msgs = (s.messages[convId] ?? []).slice(-30);
  const transcript = msgs.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`).join("\n\n").slice(0, 40_000);
  const agent = s.agents.find((a) => a.id === conv.agentId) ?? null;
  const { system } = buildSystemPrompt(s, agent, conv);

  s.toast(`Generating ${type.name}…`, "info");
  const res = await completeOnce({
    model: s.model,
    maxTokens: Math.max(s.maxTokens, 3000),
    system,
    messages: [
      {
        role: "user",
        content: `Based on this conversation, produce ${type.prompt}. Output ONLY the finished document in markdown, starting with a # title line.\n\nCONVERSATION:\n${transcript}`,
      },
    ],
  });
  if (!res.ok) {
    s.toast("Generation failed: " + res.error, "err");
    return null;
  }
  const title = res.text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? `${type.name} — ${conv.title}`;
  const artifact: Artifact = {
    id: uid(),
    title: title.slice(0, 80),
    type: type.id,
    content: res.text,
    convId,
    projectId: conv.projectId,
    createdAt: Date.now(),
  };
  const st = useStore.getState();
  useStore.setState({ artifacts: { ...st.artifacts, [artifact.id]: artifact } });
  st.toast(`${type.name} ready`, "ok");
  return artifact;
}

function safeName(title: string): string {
  return title.replace(/[^\w\- ]+/g, "").trim().slice(0, 50) || "document";
}

const HTML_SHELL = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.6;color:#111}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px}pre{background:#f4f4f4;padding:12px;border-radius:6px}</style></head><body>${body}</body></html>`;

export function exportArtifact(a: Artifact, format: "md" | "txt" | "html" | "doc") {
  const name = safeName(a.title);
  if (format === "md") downloadText(name + ".md", a.content, "text/markdown");
  else if (format === "txt") downloadText(name + ".txt", a.content.replace(/[#*_`>]/g, ""), "text/plain");
  else if (format === "html") downloadText(name + ".html", HTML_SHELL(a.title, renderMarkdown(a.content)), "text/html");
  else if (format === "doc")
    // Word-compatible HTML document (.doc): opens directly in Microsoft Word.
    downloadText(name + ".doc", HTML_SHELL(a.title, renderMarkdown(a.content)), "application/msword");
}

/** Markdown → simple standalone HTML slide deck (## heading = new slide). */
export function exportSlides(a: Artifact) {
  const slides = a.content
    .split(/\n(?=##?\s)/)
    .map((chunk) => `<section class="slide">${renderMarkdown(chunk)}</section>`)
    .join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${a.title}</title><style>
body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#111}
.slide{width:90vw;max-width:960px;min-height:80vh;margin:5vh auto;background:#fff;border-radius:14px;padding:6vh 6vw;box-sizing:border-box;line-height:1.6}
.slide h1,.slide h2{margin-top:0}
@media print{.slide{page-break-after:always;min-height:auto;margin:0;border-radius:0;width:100%}}
</style></head><body>${slides}</body></html>`;
  downloadText(safeName(a.title) + "-slides.html", html, "text/html");
}
