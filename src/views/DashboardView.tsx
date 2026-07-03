// Home dashboard: the landing view. Everything shown is real data from the
// store — tasks, alerts, live agent work, recent conversations. No metrics
// are invented; empty sections say so.
import { useMemo } from "react";
import { useStore } from "../store/store";
import { newConversation, openConversation } from "../features/chat";
import { toggleTask } from "../features/tasks";
import { activeTaskCount } from "../features/agentExec";
import { fmtDate, fmtTime } from "../lib/util";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function DashboardView() {
  const profile = useStore((s) => s.profile);
  const tasks = useStore((s) => s.tasks);
  const alerts = useStore((s) => s.proactiveAlerts);
  const agents = useStore((s) => s.agents);
  const conversations = useStore((s) => s.conversations);
  const messages = useStore((s) => s.messages);
  const setView = useStore((s) => s.setView);

  const openTasks = useMemo(() => {
    const open = tasks.filter((t) => !t.done);
    const score = (t: (typeof open)[number]) =>
      (t.due && t.due < Date.now() ? 0 : 1) * 1e15 + (t.due ?? t.createdAt + 1e12);
    return [...open].sort((a, b) => score(a) - score(b)).slice(0, 6);
  }, [tasks]);

  const unread = alerts.filter((a) => !a.read).slice(0, 4);

  const working = useMemo(
    () =>
      agents
        .map((a) => ({
          agent: a,
          running: a.taskQueue.filter((t) => t.status === "in_progress"),
          queued: a.taskQueue.filter((t) => t.status === "assigned").length,
        }))
        .filter((x) => x.running.length || x.queued),
    [agents]
  );

  const recent = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => !c.deletedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6),
    [conversations]
  );

  // Real weekly numbers, straight from logged events.
  const week = useMemo(() => {
    const weekAgo = Date.now() - 7 * 864e5;
    let sent = 0;
    for (const list of Object.values(messages)) {
      for (const m of list) if (m.role === "user" && m.ts >= weekAgo) sent++;
    }
    const agentDone = agents.reduce(
      (n, a) => n + a.workday.tasksCompleted.filter((t) => t.ts >= weekAgo).length,
      0
    );
    const tasksDone = tasks.filter((t) => t.completedAt && t.completedAt >= weekAgo).length;
    return { sent, agentDone, tasksDone };
  }, [messages, agents, tasks]);

  const totalActive = agents.reduce((n, a) => n + activeTaskCount(a), 0);

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h2 style={{ margin: 0 }}>
            {greeting()}
            {profile.name ? `, ${profile.name.split(" ")[0]}` : ""} ✦
          </h2>
          <div className="hint">
            {fmtDate(Date.now())} · {week.sent} messages, {week.tasksDone + week.agentDone} tasks completed in the last 7 days
          </div>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => newConversation()}>💬 New chat</button>
          <button className="btn" onClick={() => setView("tasks")}>☑️ Tasks</button>
          <button className="btn" onClick={() => useStore.setState({ searchOpen: true, searchMode: "all" })}>
            🔍 Search <span className="kbd">Ctrl K</span>
          </button>
        </div>
      </div>

      <div className="dash-grid">
        <div className="card">
          <h3>☑️ Up next</h3>
          {openTasks.length === 0 && <div className="hint">No open tasks. Add one from the Tasks view or type /task in chat.</div>}
          {openTasks.map((t) => (
            <div key={t.id} className="dash-task">
              <input type="checkbox" checked={false} onChange={() => toggleTask(t.id)} title="Mark done" />
              <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
              {t.due && (
                <span className={"tag" + (t.due < Date.now() ? " err" : "")}>
                  {t.due < Date.now() ? "overdue" : fmtDate(t.due)}
                </span>
              )}
            </div>
          ))}
          {tasks.filter((t) => !t.done).length > openTasks.length && (
            <button className="btn sm ghost" onClick={() => setView("tasks")}>View all →</button>
          )}
        </div>

        <div className="card">
          <h3>🔔 Needs your attention</h3>
          {unread.length === 0 && <div className="hint">All clear — no unread alerts.</div>}
          {unread.map((a) => (
            <div key={a.id} className="dash-alert" onClick={() => useStore.setState({ alertsOpen: true })}>
              <span>{a.type === "approval_needed" ? "🟠" : a.type === "task_completed" ? "✅" : "🔵"}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{a.title}</div>
                <div className="hint">{fmtTime(a.ts)} · {a.body.slice(0, 80)}</div>
              </div>
            </div>
          ))}
          {alerts.filter((a) => !a.read).length > unread.length && (
            <button className="btn sm ghost" onClick={() => useStore.setState({ alertsOpen: true })}>
              All alerts ({alerts.filter((a) => !a.read).length}) →
            </button>
          )}
        </div>

        <div className="card">
          <h3>🤖 Agents at work {totalActive > 0 && <span className="tag">{totalActive} active</span>}</h3>
          {working.length === 0 && (
            <div className="hint">No agent tasks running. Assign work from the Agent Hub or Tasks view.</div>
          )}
          {working.map(({ agent, running, queued }) => (
            <div key={agent.id} className="dash-task" style={{ cursor: "pointer" }} onClick={() => setView("workload")}>
              <span>{agent.emoji}</span>
              <span className="grow">{agent.name}</span>
              {running.length > 0 && <span className="tag ok">{running[0].title.slice(0, 26)}…</span>}
              {queued > 0 && <span className="tag">{queued} queued</span>}
            </div>
          ))}
          <button className="btn sm ghost" onClick={() => setView("workload")}>Workload →</button>
        </div>

        <div className="card">
          <h3>💬 Pick up where you left off</h3>
          {recent.length === 0 && <div className="hint">No conversations yet — start your first chat.</div>}
          {recent.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId);
            return (
              <div key={c.id} className="dash-task" style={{ cursor: "pointer" }} onClick={() => openConversation(c.id)}>
                <span>{c.agentInitiated ? "🔔" : agent?.emoji ?? "💬"}</span>
                <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                <span className="hint">{fmtDate(c.updatedAt)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
