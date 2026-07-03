// Agent task queues + real (not simulated) execution. Assigning a task calls
// the LLM to produce the finished deliverable; the streamed character count
// drives the progress display, and the result lands in a new conversation.
import { useStore } from "../store/store";
import type { Agent, AgentTask, Conversation, WebSource } from "../types";
import { uid } from "../lib/util";
import { buildSystemPrompt } from "../api/systemPrompt";
import { streamOnce, completeOnce } from "../api/anthropic";
import { runWebResearch } from "./webResearch";

function patchAgent(agentId: string, fn: (a: Agent) => Agent) {
  const s = useStore.getState();
  useStore.setState({ agents: s.agents.map((a) => (a.id === agentId ? fn(a) : a)) });
}

function patchTask(agentId: string, taskId: string, patch: Partial<AgentTask>) {
  patchAgent(agentId, (a) => ({
    ...a,
    taskQueue: a.taskQueue.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
  }));
}

export function addAgentTask(
  agentId: string,
  title: string,
  description = "",
  priority: AgentTask["priority"] = "medium",
  due?: number
): AgentTask | null {
  const s = useStore.getState();
  if (!s.agents.some((a) => a.id === agentId)) return null;
  const task: AgentTask = {
    id: uid(),
    title,
    description: description || undefined,
    status: "assigned",
    priority,
    due,
    assignedAt: Date.now(),
  };
  patchAgent(agentId, (a) => ({ ...a, taskQueue: [...a.taskQueue, task] }));
  return task;
}

export function deleteAgentTask(agentId: string, taskId: string) {
  patchAgent(agentId, (a) => ({ ...a, taskQueue: a.taskQueue.filter((t) => t.id !== taskId) }));
}

export function activeTaskCount(a: Agent): number {
  return a.taskQueue.filter((t) => t.status === "assigned" || t.status === "in_progress").length;
}

export type Availability = "available" | "busy" | "overloaded";

export function agentCapacity(a: Agent, maxTasks: number): { pct: number; availability: Availability } {
  const active = activeTaskCount(a);
  const pct = Math.min(100, Math.round((active / Math.max(1, maxTasks)) * 100));
  return { pct, availability: pct >= 90 ? "overloaded" : pct >= 60 ? "busy" : "available" };
}

const running = new Set<string>(); // agentId:taskId guards double-runs

// Pre-execution decision: does this task need live web information?
const RESEARCH_TOOLS = [
  {
    name: "web_research",
    description:
      "Fetch live web information before producing the deliverable. Use ONLY when current external facts (prices, news, competitor moves, regulations, market data) would materially improve the result.",
    input_schema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "1-2 focused search queries",
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "no_research_needed",
    description: "The task can be completed well from existing knowledge and business context.",
    input_schema: { type: "object", properties: {} },
  },
];

/**
 * Optional research step before execution (only when the user has web
 * research enabled): the agent decides whether live info would help, then
 * up to 2 searches run and their findings feed the deliverable.
 */
async function gatherTaskResearch(
  model: string,
  system: string,
  taskPrompt: string
): Promise<{ context: string; sources: WebSource[] } | null> {
  const decide = await completeOnce({
    model,
    maxTokens: 300,
    system,
    tools: RESEARCH_TOOLS,
    messages: [
      {
        role: "user",
        content: `Before producing the deliverable, decide whether LIVE web information would materially improve it. Use exactly one tool.\n\n${taskPrompt}`,
      },
    ],
  });
  if (!decide.ok || decide.toolUses[0]?.name !== "web_research") return null;
  const queries = ((decide.toolUses[0].input.queries as unknown[]) ?? [])
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .slice(0, 2);
  const chunks: string[] = [];
  const sources: WebSource[] = [];
  for (const q of queries) {
    const r = await runWebResearch(q);
    if (r) {
      chunks.push(`RESEARCH QUERY: ${q}\n${r.context}`);
      sources.push(...r.sources);
    }
  }
  return chunks.length ? { context: chunks.join("\n\n"), sources } : null;
}

/**
 * Execute an assigned/blocked agent task for real. Status transitions are
 * driven by the actual API call; progress = characters streamed so far.
 */
export async function runAgentTask(agentId: string, taskId: string): Promise<void> {
  const key = `${agentId}:${taskId}`;
  if (running.has(key)) return;
  const s = useStore.getState();
  const agent = s.agents.find((a) => a.id === agentId);
  const task = agent?.taskQueue.find((t) => t.id === taskId);
  if (!agent || !task || task.status === "in_progress" || task.status === "completed") return;
  if (!s.hasApiKey) {
    s.toast("Add your Anthropic API key in Settings before assigning agent tasks.", "err");
    return;
  }

  running.add(key);
  patchTask(agentId, taskId, { status: "in_progress", startedAt: Date.now(), streamedChars: 0, blockers: [] });

  const { system } = buildSystemPrompt(s, agent, null, task.title + " " + (task.description ?? ""));
  const model = agent.model || s.model;
  const taskPrompt =
    `You have been assigned this task. Produce the FINISHED DELIVERABLE now — not a plan, not questions, the actual completed work product, ready to use.\n\n` +
    `TASK: ${task.title}` +
    (task.description ? `\n\nDETAILS: ${task.description}` : "") +
    (task.due ? `\n\nDUE: ${new Date(task.due).toLocaleDateString()}` : "");

  // Multi-step: optional live research pass first (only if the user enabled web research).
  let research: { context: string; sources: WebSource[] } | null = null;
  if (s.settings.webResearchMode) {
    research = await gatherTaskResearch(model, system, taskPrompt);
    if (research) patchTask(agentId, taskId, { webSources: research.sources });
  }

  const result = await streamOnce(
    {
      model,
      maxTokens: Math.max(s.maxTokens, 2048),
      system: system + "\n\nYou are completing an assigned work task autonomously. Deliver complete, polished output.",
      messages: [
        {
          role: "user",
          content:
            taskPrompt +
            (research
              ? `\n\n---\nLIVE WEB RESEARCH (fetched just now for this task — cite sources where used):\n\n${research.context}`
              : ""),
        },
      ],
    },
    (chars) => patchTask(agentId, taskId, { streamedChars: chars })
  );
  running.delete(key);

  if (result.ok) {
    // Post the deliverable into a new conversation so the user can read/continue it.
    const st = useStore.getState();
    const conv: Conversation = {
      id: uid(),
      title: `✅ ${task.title}`.slice(0, 60),
      agentId,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentInitiated: true,
    };
    useStore.setState({
      conversations: { ...st.conversations, [conv.id]: conv },
      messages: {
        ...st.messages,
        [conv.id]: [
          { id: uid(), role: "user", content: `**Task assigned:** ${task.title}${task.description ? `\n\n${task.description}` : ""}`, ts: Date.now() },
          { id: uid(), role: "assistant", content: result.text, ts: Date.now(), agentId, webSources: research?.sources },
        ],
      },
    });
    patchTask(agentId, taskId, {
      status: "completed",
      completedAt: Date.now(),
      output: result.text,
      convId: conv.id,
    });
    patchAgent(agentId, (a) => ({
      ...a,
      workday: {
        ...a.workday,
        tasksCompleted: [...a.workday.tasksCompleted, { title: task.title, ts: Date.now() }].slice(-100),
      },
      goals: a.goals.map((g) =>
        relatedToGoal(task.title, g.text) ? { ...g, lastActivity: Date.now() } : g
      ),
    }));
    useStore.getState().addAlert({
      agentId,
      type: "task_completed",
      title: `${useStore.getState().agents.find((a) => a.id === agentId)?.name ?? "Agent"} completed: ${task.title}`,
      body: result.text.slice(0, 180) + (result.text.length > 180 ? "…" : ""),
      convId: conv.id,
    });
    useStore.getState().toast(`Task completed: ${task.title}`, "ok");
  } else {
    patchTask(agentId, taskId, {
      status: "blocked",
      blockers: [result.error],
    });
    useStore.getState().toast(`Task blocked: ${result.error}`, "err");
  }
}

function relatedToGoal(taskTitle: string, goalText: string): boolean {
  const words = goalText.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const t = taskTitle.toLowerCase();
  return words.some((w) => t.includes(w));
}

/**
 * Hand a completed deliverable to another agent: creates a task for the
 * recipient with the original output as context, and runs it.
 */
export function handOffTask(fromAgentId: string, taskId: string, toAgentId: string, instruction?: string) {
  const s = useStore.getState();
  const from = s.agents.find((a) => a.id === fromAgentId);
  const to = s.agents.find((a) => a.id === toAgentId);
  const task = from?.taskQueue.find((t) => t.id === taskId);
  if (!from || !to || !task || !task.output) return;
  const t = addAgentTask(
    toAgentId,
    `${instruction || "Review and improve"}: ${task.title}`.slice(0, 90),
    `${from.name} (${from.role}) completed the task "${task.title}" and handed the result to you${instruction ? ` with the instruction: ${instruction}` : " for review from your discipline's perspective"}.\n\nTHEIR DELIVERABLE:\n${task.output.slice(0, 12_000)}`,
    task.priority
  );
  s.toast(`Handed off to ${to.emoji} ${to.name}`, "ok");
  if (t && s.hasApiKey) void runAgentTask(toAgentId, t.id);
}

/** Real per-agent performance metrics derived from logged events only. */
export function agentStats(a: Agent, allMessages: Record<string, import("../types").Message[]>) {
  const weekAgo = Date.now() - 7 * 864e5;
  const completed = a.taskQueue.filter((t) => t.status === "completed");
  const durations = completed
    .filter((t) => t.startedAt && t.completedAt)
    .map((t) => t.completedAt! - t.startedAt!);
  let up = 0;
  let down = 0;
  for (const msgs of Object.values(allMessages)) {
    for (const m of msgs) {
      if (m.agentId === a.id && m.rating === 1) up++;
      if (m.agentId === a.id && m.rating === -1) down++;
    }
  }
  return {
    completedAllTime: a.workday.tasksCompleted.length,
    completedThisWeek: a.workday.tasksCompleted.filter((t) => t.ts >= weekAgo).length,
    initiativesStarted: a.workday.initiativesStarted.length,
    avgCompletionMs: durations.length ? durations.reduce((x, y) => x + y, 0) / durations.length : null,
    blockedNow: a.taskQueue.filter((t) => t.status === "blocked").length,
    ratingsUp: up,
    ratingsDown: down,
    learnings: a.memory.learnings.length,
  };
}

/** Run every assigned task in an agent's queue (used by "Run all"). */
export async function runAllAssigned(agentId: string) {
  const s = useStore.getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent) return;
  for (const t of agent.taskQueue.filter((t) => t.status === "assigned")) {
    await runAgentTask(agentId, t.id);
  }
}
