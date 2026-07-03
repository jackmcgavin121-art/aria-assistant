// Global tasks + recurring schedules + post-reply task suggestion.
import { useStore } from "../store/store";
import type { Task, RecurringTaskDef } from "../types";
import { uid } from "../lib/util";
import { runAgentTask, addAgentTask } from "./agentExec";

export function addTask(t: Partial<Task> & { title: string }): Task {
  const s = useStore.getState();
  const task: Task = {
    id: uid(),
    done: false,
    createdAt: Date.now(),
    priority: "medium",
    ...t,
  };
  useStore.setState({ tasks: [task, ...s.tasks] });
  // Assigning to an agent with auto-execute queues real work immediately.
  if (task.agentId && task.autoExec) {
    const at = addAgentTask(task.agentId, task.title, "", task.priority, task.due);
    if (at) void runAgentTask(task.agentId, at.id);
  }
  return task;
}

export function toggleTask(id: string) {
  const s = useStore.getState();
  useStore.setState({
    tasks: s.tasks.map((t) =>
      t.id === id ? { ...t, done: !t.done, completedAt: !t.done ? Date.now() : undefined } : t
    ),
  });
}

export function deleteTask(id: string) {
  const s = useStore.getState();
  useStore.setState({ tasks: s.tasks.filter((t) => t.id !== id) });
}

/* ---------------- recurring ---------------- */

export function computeNextDue(def: Omit<RecurringTaskDef, "id" | "nextDueAt" | "title">, from = Date.now()): number {
  const base = new Date(from);
  const [hh, mm] = (def.timeOfDay || "09:00").split(":").map(Number);
  const at = (d: Date) => {
    d.setHours(hh || 9, mm || 0, 0, 0);
    return d;
  };
  if (def.freq === "daily") {
    const d = at(new Date(base));
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (def.freq === "weekly") {
    const days = def.days?.length ? def.days : [1];
    for (let i = 0; i <= 7; i++) {
      const d = at(new Date(base));
      d.setDate(d.getDate() + i);
      if (days.includes(d.getDay()) && d.getTime() > from) return d.getTime();
    }
  }
  if (def.freq === "monthly") {
    const d = at(new Date(base));
    if (d.getTime() <= from) d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }
  // custom: every N days
  const n = Math.max(1, def.intervalDays ?? 1);
  const d = at(new Date(base));
  if (d.getTime() <= from) d.setDate(d.getDate() + n);
  return d.getTime();
}

export function addRecurring(def: Omit<RecurringTaskDef, "id" | "nextDueAt">): RecurringTaskDef {
  const s = useStore.getState();
  const full: RecurringTaskDef = { ...def, id: uid(), nextDueAt: computeNextDue(def) };
  useStore.setState({ recurringTasks: [...s.recurringTasks, full] });
  return full;
}

export function deleteRecurring(id: string) {
  const s = useStore.getState();
  useStore.setState({ recurringTasks: s.recurringTasks.filter((r) => r.id !== id) });
}

/** Fire any due recurring defs → creates real tasks; called by the 60s scheduler. */
export function fireRecurringTasks() {
  const s = useStore.getState();
  const now = Date.now();
  let changed = false;
  const updated = s.recurringTasks.map((r) => {
    if (r.nextDueAt > now) return r;
    changed = true;
    addTask({
      title: r.title,
      due: r.nextDueAt,
      recurringId: r.id,
      agentId: r.agentId,
      autoExec: r.autoExec,
      projectId: r.projectId,
    });
    return { ...r, lastFiredAt: now, nextDueAt: computeNextDue(r, now) };
  });
  if (changed) useStore.setState({ recurringTasks: updated });
}

let recurTimer: number | undefined;
export function initRecurringScheduler() {
  window.clearInterval(recurTimer);
  fireRecurringTasks();
  recurTimer = window.setInterval(fireRecurringTasks, 60_000);
}

/* ---------------- post-reply task suggestion ---------------- */

export interface TaskSuggestion {
  convId: string;
  items: string[];
}

let lastSuggestedConv = "";

/**
 * After an assistant reply, scan for list-like actionable content and surface
 * a suggestion (stored in ephemeral state read by the Tasks strip in chat).
 */
export function checkTaskSuggestion(): TaskSuggestion | null {
  const s = useStore.getState();
  const convId = s.activeConvId;
  if (!convId || convId === lastSuggestedConv) return null;
  const list = s.messages[convId] ?? [];
  const last = list[list.length - 1];
  if (!last || last.role !== "assistant") return null;

  const items: string[] = [];
  for (const line of last.content.split("\n")) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(?:\*\*)?([A-Z].{8,90}?)(?:\*\*)?\s*$/);
    if (m) {
      const t = m[1].trim();
      // Only imperative-looking items (start with a verb-ish word, no colon-heavy headings).
      if (!/[:?]$/.test(t)) items.push(t);
    }
  }
  if (items.length < 2) return null;
  lastSuggestedConv = convId;
  const suggestion = { convId, items: items.slice(0, 8) };
  useStore.getState().toast(`Found ${suggestion.items.length} possible tasks in that reply`, "info", {
    label: "Add as tasks",
    onClick: () => {
      for (const t of suggestion.items) addTask({ title: t });
      useStore.getState().toast(`Added ${suggestion.items.length} tasks`, "ok");
    },
  });
  return suggestion;
}
