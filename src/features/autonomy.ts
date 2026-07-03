// Autonomy loop (opt-in per agent): think → decide (structured JSON plan) →
// execute → reflect. Risky/low-confidence plans raise an approval alert
// instead of auto-acting. Also: proactive periodic checks + weekly reports —
// all derived from real logged activity, never fabricated.
import { useStore } from "../store/store";
import type { Agent, Goal } from "../types";
import { completeOnce } from "../api/anthropic";
import { buildSystemPrompt } from "../api/systemPrompt";
import { addAgentTask, runAgentTask } from "./agentExec";
import { uid } from "../lib/util";

function patchAgent(agentId: string, fn: (a: Agent) => Agent) {
  const s = useStore.getState();
  useStore.setState({ agents: s.agents.map((a) => (a.id === agentId ? fn(a) : a)) });
}

/* ---------------- goals ---------------- */

export function goalProgress(g: Goal): number | null {
  if (typeof g.current !== "number" || typeof g.target !== "number" || g.target === 0) return null;
  return Math.min(100, Math.round((g.current / g.target) * 100));
}

const STALL_DAYS = 7;

export function isGoalStalled(g: Goal): boolean {
  const last = g.lastActivity ?? g.createdAt;
  return Date.now() - last > STALL_DAYS * 864e5;
}

/* ---------------- autonomy loop ---------------- */

interface Plan {
  action: "create_task" | "flag_user" | "none";
  title?: string;
  description?: string;
  reasoning?: string;
  confidence?: number; // 0-1
  risk?: "low" | "medium" | "high";
}

// The decide step uses real tool definitions — structured input the model
// must fill in, far more reliable than parsing JSON out of prose.
const AUTONOMY_TOOLS = [
  {
    name: "create_task",
    description:
      "Queue a concrete deliverable you can produce yourself (a document, analysis, draft, plan). Use only for work that clearly advances one of your goals.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative task title" },
        description: { type: "string", description: "What the finished deliverable should contain" },
        reasoning: { type: "string", description: "Why this advances your goals" },
        confidence: { type: "number", description: "0-1: how sure you are this is the right next step" },
        risk: { type: "string", enum: ["low", "medium", "high"], description: "Risk if this work is wrong or unwanted" },
      },
      required: ["title", "description", "confidence", "risk"],
    },
  },
  {
    name: "flag_user",
    description: "Raise something that needs the user's attention or decision — do NOT use for work you could do yourself.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        reasoning: { type: "string", description: "What the user needs to know or decide" },
      },
      required: ["title", "reasoning"],
    },
  },
  {
    name: "do_nothing",
    description: "Nothing useful to do right now. Choose this freely — don't invent work for its own sake.",
    input_schema: { type: "object", properties: {} },
  },
];

/**
 * One autonomy cycle for one agent: a single tool-use decision call, then
 * either queue + run a real task (low risk, high confidence, autonomyLevel
 * "auto") or raise an approval alert.
 */
export async function runAutonomyCycle(agentId: string): Promise<void> {
  const s = useStore.getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent || agent.autonomyLevel === "off" || !s.hasApiKey) return;
  if (!agent.goals.length) return;

  const { system } = buildSystemPrompt(s, agent, null);
  const context =
    `YOUR GOALS:\n${agent.goals.map((g) => `- [${g.priority}] ${g.text}${isGoalStalled(g) ? " (STALLED — no activity for a week)" : ""}`).join("\n")}\n\n` +
    `RECENTLY COMPLETED: ${agent.workday.tasksCompleted.slice(-5).map((t) => t.title).join("; ") || "nothing yet"}\n` +
    `OPEN QUEUE: ${agent.taskQueue.filter((t) => t.status !== "completed").map((t) => t.title).join("; ") || "empty"}`;

  const res = await completeOnce({
    model: agent.model || s.model,
    maxTokens: 600,
    system,
    tools: AUTONOMY_TOOLS,
    messages: [
      {
        role: "user",
        content: `Review your goals and current workload, then decide ONE next action using exactly one of your tools.\n\n${context}`,
      },
    ],
  });
  if (!res.ok || !res.toolUses.length) return;

  const use = res.toolUses[0];
  if (use.name === "do_nothing") return;
  const input = use.input as Record<string, any>;
  const plan: Plan = {
    action: use.name === "create_task" ? "create_task" : "flag_user",
    title: typeof input.title === "string" ? input.title : undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    reasoning: typeof input.reasoning === "string" ? input.reasoning : undefined,
    confidence: typeof input.confidence === "number" ? input.confidence : undefined,
    risk: input.risk === "low" || input.risk === "high" ? input.risk : "medium",
  };

  const store = useStore.getState();
  const lowRisk = (plan.risk ?? "medium") === "low" && (plan.confidence ?? 0) >= 0.7;

  if (plan.action === "create_task" && agent.autonomyLevel === "auto" && lowRisk) {
    const t = addAgentTask(agentId, plan.title || "Autonomous task", plan.description || plan.reasoning || "");
    if (t) {
      patchAgent(agentId, (a) => ({
        ...a,
        workday: {
          ...a.workday,
          initiativesStarted: [...a.workday.initiativesStarted, { title: t.title, ts: Date.now() }].slice(-100),
        },
      }));
      void runAgentTask(agentId, t.id);
    }
    return;
  }

  // Everything else needs the user's sign-off: raise an approval alert.
  store.addAlert({
    agentId,
    type: "approval_needed",
    title: `${agent.name} proposes: ${plan.title || "an action"}`,
    body: (plan.reasoning || plan.description || "").slice(0, 300),
    proposedAction:
      plan.action === "create_task"
        ? { taskTitle: plan.title || "Task", taskDescription: plan.description || "" }
        : undefined,
  });
}

export function approveProposal(alertId: string) {
  const s = useStore.getState();
  const alert = s.proactiveAlerts.find((a) => a.id === alertId);
  if (!alert?.proposedAction) return;
  const t = addAgentTask(alert.agentId, alert.proposedAction.taskTitle, alert.proposedAction.taskDescription);
  markAlertRead(alertId);
  if (t) void runAgentTask(alert.agentId, t.id);
}

export function markAlertRead(alertId: string) {
  const s = useStore.getState();
  useStore.setState({
    proactiveAlerts: s.proactiveAlerts.map((a) => (a.id === alertId ? { ...a, read: true } : a)),
  });
}

export function dismissAlert(alertId: string) {
  const s = useStore.getState();
  useStore.setState({ proactiveAlerts: s.proactiveAlerts.filter((a) => a.id !== alertId) });
}

/* ---------------- proactive periodic check ---------------- */

const THROTTLE_HOURS = 6;
const throttleKey = (agentId: string, kind: string, ref: string) => `${agentId}|${kind}|${ref}`;
const lastAlerted = new Map<string, number>();

function throttled(key: string): boolean {
  const last = lastAlerted.get(key) ?? 0;
  if (Date.now() - last < THROTTLE_HOURS * 3600e3) return true;
  lastAlerted.set(key, Date.now());
  return false;
}

/** Local scan (no API calls): stalled/critical goals + overdue queue tasks. */
export function proactiveScan() {
  const s = useStore.getState();
  for (const agent of s.agents) {
    if (!agent.proactiveMode) continue;
    for (const g of agent.goals) {
      if (g.priority === "high" && isGoalStalled(g) && !throttled(throttleKey(agent.id, "stall", g.id))) {
        s.addAlert({
          agentId: agent.id,
          type: "goal_stalled",
          title: `${agent.name}: goal stalled — ${g.text.slice(0, 60)}`,
          body: `No related activity for over ${STALL_DAYS} days. Consider assigning a task or revising the goal.`,
        });
      }
    }
    for (const t of agent.taskQueue) {
      if (
        t.due &&
        t.due < Date.now() &&
        (t.status === "assigned" || t.status === "blocked") &&
        !throttled(throttleKey(agent.id, "overdue", t.id))
      ) {
        s.addAlert({
          agentId: agent.id,
          type: "task_overdue",
          title: `${agent.name}: task overdue — ${t.title.slice(0, 60)}`,
          body: t.status === "blocked" ? `Blocked: ${t.blockers?.[0] ?? "unknown"}` : "Still waiting to run.",
        });
      }
    }
  }
}

/* ---------------- background autonomy scheduler ---------------- */

/** Agents with autonomy on think for themselves every AUTONOMY_INTERVAL_HOURS. */
const AUTONOMY_INTERVAL_HOURS = 6;

/**
 * One scheduler tick: run an autonomy cycle for at most ONE due agent
 * (spreads API cost across ticks instead of bursting).
 */
export async function autonomyTick(): Promise<void> {
  const s = useStore.getState();
  if (!s.hasApiKey) return;
  const due = s.agents.find(
    (a) =>
      a.autonomyLevel !== "off" &&
      a.goals.length > 0 &&
      Date.now() - (a.lastAutonomyRunAt ?? 0) > AUTONOMY_INTERVAL_HOURS * 3600e3
  );
  if (!due) return;
  // Stamp before running so a failing call can't retry-loop every tick.
  patchAgent(due.id, (a) => ({ ...a, lastAutonomyRunAt: Date.now() }));
  await runAutonomyCycle(due.id);
}

/* ---------------- automatic weekly reports ---------------- */

function startOfWeek(now = Date.now()): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

/**
 * From Monday 08:00, generate one report per proactive agent that actually
 * did something last week (max 2 per tick to spread cost).
 */
export async function weeklyReportTick(): Promise<void> {
  const s = useStore.getState();
  if (!s.hasApiKey) return;
  const weekStart = startOfWeek();
  if (Date.now() < weekStart + 8 * 3600e3) return; // not yet Monday morning
  const weekAgo = Date.now() - 7 * 864e5;

  const due = s.agents
    .filter(
      (a) =>
        a.proactiveMode &&
        (a.lastWeeklyReportAt ?? 0) < weekStart &&
        (a.workday.tasksCompleted.some((t) => t.ts >= weekAgo) ||
          a.workday.initiativesStarted.some((t) => t.ts >= weekAgo) ||
          a.goals.length > 0)
    )
    .slice(0, 2);

  for (const agent of due) {
    patchAgent(agent.id, (a) => ({ ...a, lastWeeklyReportAt: Date.now() }));
    const report = await generateWeeklyReport(agent.id);
    if (!report) continue;
    const st = useStore.getState();
    const convId = uid();
    useStore.setState({
      conversations: {
        ...st.conversations,
        [convId]: {
          id: convId,
          title: `📊 Weekly report — ${agent.name}`.slice(0, 60),
          agentId: agent.id,
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          agentInitiated: true,
        },
      },
      messages: {
        ...st.messages,
        [convId]: [
          { id: uid(), role: "user", content: "**Automatic weekly report** (generated from real logged activity).", ts: Date.now() },
          { id: uid(), role: "assistant", content: report, ts: Date.now(), agentId: agent.id },
        ],
      },
    });
    useStore.getState().addAlert({
      agentId: agent.id,
      type: "info",
      title: `${agent.name}: weekly report is ready`,
      body: report.slice(0, 180),
      convId,
    });
  }
}

let proactiveTimer: number | undefined;
let autonomyKickoff: number | undefined;
export function initProactiveChecks() {
  window.clearInterval(proactiveTimer);
  window.clearTimeout(autonomyKickoff);
  proactiveScan();
  proactiveTimer = window.setInterval(() => {
    proactiveScan();
    void autonomyTick();
    void weeklyReportTick();
  }, 30 * 60_000);
  // First background think shortly after boot (don't compete with startup).
  autonomyKickoff = window.setTimeout(() => {
    void autonomyTick();
    void weeklyReportTick();
  }, 90_000);
}

/* ---------------- weekly report ---------------- */

/** Generate a weekly report from the agent's real logged activity. */
export async function generateWeeklyReport(agentId: string): Promise<string | null> {
  const s = useStore.getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent || !s.hasApiKey) return null;
  const weekAgo = Date.now() - 7 * 864e5;

  const completed = agent.workday.tasksCompleted.filter((t) => t.ts >= weekAgo);
  const initiatives = agent.workday.initiativesStarted.filter((t) => t.ts >= weekAgo);
  const blockers = agent.workday.blockers.filter((b) => b.ts >= weekAgo);
  const queueBlocked = agent.taskQueue.filter((t) => t.status === "blocked");
  const goalsLines = agent.goals.map((g) => {
    const p = goalProgress(g);
    return `- [${g.priority}] ${g.text}${p !== null ? ` — ${p}% (${g.current}/${g.target}${g.metric ? " " + g.metric : ""})` : ""}${isGoalStalled(g) ? " [STALLED]" : ""}`;
  });

  const activityLog =
    `GOALS:\n${goalsLines.join("\n") || "(none set)"}\n\n` +
    `COMPLETED THIS WEEK (${completed.length}):\n${completed.map((t) => `- ${t.title}`).join("\n") || "(none)"}\n\n` +
    `INITIATIVES STARTED (${initiatives.length}):\n${initiatives.map((t) => `- ${t.title}`).join("\n") || "(none)"}\n\n` +
    `BLOCKERS:\n${[...blockers.map((b) => `- ${b.text}`), ...queueBlocked.map((t) => `- ${t.title}: ${t.blockers?.[0] ?? ""}`)].join("\n") || "(none)"}\n\n` +
    `LEARNINGS LOGGED:\n${agent.memory.learnings.slice(-6).map((l) => `- ${l}`).join("\n") || "(none)"}`;

  const { system } = buildSystemPrompt(s, agent, null);
  const res = await completeOnce({
    model: agent.model || s.model,
    maxTokens: 1500,
    system,
    messages: [
      {
        role: "user",
        content:
          `Write your weekly report as ${agent.name} based STRICTLY on this real activity log — do not invent numbers or accomplishments that aren't in it. If a section has no data, say so honestly.\n\n${activityLog}\n\n` +
          `Format in markdown with sections: Goals status · Wins · Learnings · Blockers · Skill gaps · Recommendations for next week.`,
      },
    ],
  });
  return res.ok ? res.text : null;
}
