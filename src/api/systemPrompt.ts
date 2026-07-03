// System-prompt assembly — ported from V13's buildSystemPrompt, adapted to the
// v2 state shape. Injected knowledge is capped and truncation is reported so
// the UI can tell the user when content was cut (spec guardrail).
import type { Agent, Conversation } from "../types";
import type { Store } from "../store/store";
import { PERSONALITIES } from "../data/presets";

const KNOWLEDGE_TOTAL_CAP = 60_000;
const KNOWLEDGE_PER_DOC_CAP = 15_000;

export interface BuiltPrompt {
  system: string;
  truncatedDocs: string[]; // names of docs that didn't fully fit
}

/** Split a document into paragraph-aligned chunks of roughly `size` chars. */
function chunkDoc(content: string, size = 1600): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of content.split(/\n{2,}/)) {
    if (cur.length + para.length > size && cur) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + para;
    while (cur.length > size * 1.5) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Keyword relevance score of a chunk against the user's message. */
function scoreChunk(chunk: string, terms: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const t of terms) {
    let idx = -1;
    let n = 0;
    while ((idx = lower.indexOf(t, idx + 1)) !== -1 && n < 8) n++;
    score += n * (t.length > 6 ? 2 : 1);
  }
  return score;
}

export function buildSystemPrompt(
  s: Store,
  agent: Agent | null,
  conv?: Conversation | null,
  query?: string
): BuiltPrompt {
  const truncatedDocs: string[] = [];
  let out = agent?.instructions?.trim() || "You are ARIA, a helpful AI business assistant.";

  if (agent?.personality && PERSONALITIES[agent.personality]) {
    out += "\n\nCOMMUNICATION STYLE: " + PERSONALITIES[agent.personality].prompt;
  }
  if (agent?.knowledge?.trim()) {
    out += "\n\nYOUR PRIVATE KNOWLEDGE BASE:\n" + agent.knowledge.trim();
  }

  const rules = s.settings.adminRules;
  if (rules.enabled) {
    const parts: string[] = [];
    if (rules.noPersonalAdvice) parts.push("Do not give personal legal, medical, or financial advice — refer to a professional.");
    if (rules.formalOnly) parts.push("Always respond formally and professionally.");
    if (rules.noOffTopic && rules.offTopicBlock) parts.push(`Stay on topic. Do not discuss: ${rules.offTopicBlock}.`);
    if (rules.customRule.trim()) parts.push(rules.customRule.trim());
    if (parts.length) out += "\n\nADMIN RULES (strictly follow):\n" + parts.map((p) => "- " + p).join("\n");
  }

  const p = s.profile;
  if (p.name || p.jobRole || p.company) {
    out += "\n\nUser context:";
    if (p.name) out += ` Name: ${p.name}.`;
    if (p.jobRole) out += ` Role: ${p.jobRole}.`;
    if (p.company) out += ` Company: ${p.company}.`;
    if (p.industry) out += ` Industry: ${p.industry}.`;
    out += " Use their name occasionally. Tailor responses to their professional context.";
  }

  const b = s.businessProfile;
  if (Object.values(b).some((v) => v && v.trim()) || p.company || p.industry) {
    out += "\n\nBUSINESS CONTEXT — You already know this as a team member. Reference it naturally:\n";
    if (p.company) out += `Company: ${p.company}\n`;
    if (p.industry) out += `Industry: ${p.industry}\n`;
    if (b.description) out += `What we do: ${b.description}\n`;
    if (b.products) out += `Products/Services: ${b.products}\n`;
    if (b.customers) out += `Target customers: ${b.customers}\n`;
    if (b.keyAccounts) out += `Key accounts: ${b.keyAccounts}\n`;
    if (b.competitors) out += `Competitors: ${b.competitors}\n`;
    if (b.advantages) out += `Advantages: ${b.advantages}\n`;
    if (b.team) out += `Team: ${b.team}\n`;
    if (b.initiatives) out += `Initiatives: ${b.initiatives}\n`;
    if (b.notes) out += `Notes: ${b.notes}\n`;
  }

  if (conv?.projectId && s.projects[conv.projectId]) {
    const proj = s.projects[conv.projectId];
    if (proj.knowledge.trim() || proj.notes.trim()) {
      out += `\n\nPROJECT: "${proj.name}":\n`;
      if (proj.knowledge.trim()) out += `Knowledge:\n${proj.knowledge}\n`;
      if (proj.notes.trim()) out += `Notes:\n${proj.notes}\n`;
    }
  }

  const cm = s.companyMemory;
  if (cm.customers.length || cm.products.length || cm.equipment.length || cm.processes.length) {
    out += "\n\nCOMPANY RECORDS — Reference accurately when relevant:\n";
    if (cm.customers.length)
      out += `CUSTOMERS (${cm.customers.length}): ` + cm.customers.slice(0, 10).map((c) => c.name).join(", ") + "\n";
    if (cm.products.length) out += "PRODUCTS: " + cm.products.slice(0, 8).map((x) => x.name).join(", ") + "\n";
    if (cm.equipment.length) out += "EQUIPMENT: " + cm.equipment.slice(0, 8).map((x) => x.name).join(", ") + "\n";
    if (cm.processes.length) out += "PROCESSES: " + cm.processes.slice(0, 8).map((x) => x.name).join(", ") + "\n";
  }

  const docs = s.fileKnowledge.filter(
    (f) => !f.agentIds.length || !agent?.id || f.agentIds.includes(agent.id)
  );
  if (docs.length) {
    const totalChars = docs.reduce((n, d) => n + d.content.length, 0);
    const terms = (query ?? "").toLowerCase().split(/\W+/).filter((t) => t.length > 3);

    if (totalChars > KNOWLEDGE_TOTAL_CAP && terms.length) {
      // Retrieval mode: rank paragraph chunks by relevance to the user's
      // message and inject only the best ones, instead of the first 60k chars.
      const scored: { doc: string; category: string; chunk: string; score: number }[] = [];
      for (const f of docs) {
        const nameBoost = scoreChunk(f.name, terms) * 3;
        for (const chunk of chunkDoc(f.content)) {
          scored.push({ doc: f.name, category: f.category, chunk, score: scoreChunk(chunk, terms) + nameBoost });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const picked = [];
      let total = 0;
      for (const c of scored) {
        if (c.score <= 0 || total + c.chunk.length > KNOWLEDGE_TOTAL_CAP) continue;
        picked.push(c);
        total += c.chunk.length;
        if (picked.length >= 24) break;
      }
      if (picked.length) {
        out += "\n\nKNOWLEDGE BASE — most relevant excerpts for this request. Cite sources inline as [Ref: filename].\n";
        // Group back per document, in document order, for readability.
        const byDoc = new Map<string, { category: string; chunks: string[] }>();
        for (const c of picked) {
          if (!byDoc.has(c.doc)) byDoc.set(c.doc, { category: c.category, chunks: [] });
          byDoc.get(c.doc)!.chunks.push(c.chunk);
        }
        for (const [name, { category, chunks }] of byDoc) {
          out += `\n### ${name} [${category || "general"}] (excerpts)\n${chunks.join("\n[…]\n")}\n`;
        }
        const skipped = docs.filter((d) => !byDoc.has(d.name)).map((d) => d.name);
        truncatedDocs.push(...skipped);
      }
    } else {
      out += "\n\nKNOWLEDGE BASE — cite sources inline as [Ref: filename] when using document content.\n";
      let total = 0;
      for (const f of docs) {
        const chunk = f.content.slice(0, KNOWLEDGE_PER_DOC_CAP);
        if (total + chunk.length > KNOWLEDGE_TOTAL_CAP) {
          truncatedDocs.push(f.name);
          continue;
        }
        if (chunk.length < f.content.length) truncatedDocs.push(f.name);
        out += `\n### ${f.name} [${f.category || "general"}]\n${chunk}\n`;
        total += chunk.length;
      }
    }
  }

  const ws = s.workspace;
  if (ws && (ws.org || ws.departments.length || ws.roles.length || ws.employees.length)) {
    out += "\n\nORGANISATION — your workplace. Reference these people, teams and roles naturally when relevant:\n";
    if (ws.org) out += `Organisation: ${ws.org}\n`;
    if (ws.departments.length) out += `Departments: ${ws.departments.join(", ")}\n`;
    if (ws.roles.length) out += `Roles: ${ws.roles.join(", ")}\n`;
    if (ws.employees.length)
      out += `People: ${ws.employees.map((e) => e.name + (e.role ? ` (${e.role})` : "")).join("; ")}\n`;
  }

  // Agentic context: goals + recent learnings, only when the agent has any.
  if (agent && (agent.goals.length || agent.memory.learnings.length)) {
    if (agent.goals.length) {
      out += "\n\nYOUR CURRENT GOALS:\n" + agent.goals
        .map((g) => `- [${g.priority}] ${g.text}${g.metric ? ` (${g.metric}: ${g.current ?? "?"}/${g.target ?? "?"})` : ""}`)
        .join("\n");
    }
    if (agent.memory.learnings.length) {
      out += "\n\nTHINGS YOU'VE LEARNED (from past work):\n" + agent.memory.learnings.slice(-8).map((l) => "- " + l).join("\n");
    }
  }

  return { system: out, truncatedDocs };
}
