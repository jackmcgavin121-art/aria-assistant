import { useState } from "react";
import { useStore } from "../store/store";
import type { Agent, Goal } from "../types";
import { Modal } from "../components/Modal";
import { uid, fmtDate, clamp } from "../lib/util";
import { addAgentTask, runAgentTask, deleteAgentTask, agentCapacity, activeTaskCount, agentStats } from "../features/agentExec";
import { goalProgress, isGoalStalled, generateWeeklyReport, runAutonomyCycle } from "../features/autonomy";
import { renderMarkdown } from "../lib/markdown";
import { openConversation } from "../features/chat";
import { downloadText } from "../lib/download";
import { RecurringModal } from "./TasksView";

const AVAIL_COLOR: Record<string, string> = {
  available: "var(--ok)",
  busy: "var(--warn)",
  overloaded: "var(--err)",
};

function TaskRing({ pct }: { pct: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg width="42" height="42" viewBox="0 0 42 42">
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--bg4)" strokeWidth="5" />
      <circle
        cx="21" cy="21" r={r} fill="none" stroke="var(--ac)" strokeWidth="5"
        strokeDasharray={`${(clamp(pct, 0, 100) / 100) * c} ${c}`}
        strokeLinecap="round" transform="rotate(-90 21 21)"
      />
      <text x="21" y="25" textAnchor="middle" fontSize="10" fill="var(--tx2)" fontWeight="600">{Math.round(pct)}%</text>
    </svg>
  );
}

function GoalsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [goals, setGoals] = useState<Goal[]>([...agent.goals]);
  const [text, setText] = useState("");
  const save = () => {
    const s = useStore.getState();
    useStore.setState({ agents: s.agents.map((a) => (a.id === agent.id ? { ...a, goals } : a)) });
    onClose();
  };
  return (
    <Modal title={`${agent.emoji} ${agent.name} — goals`} onClose={onClose} footer={<button className="btn primary" onClick={save}>Save goals</button>}>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="input grow" placeholder="Add a goal… (Enter)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            setGoals([...goals, { id: uid(), text: text.trim(), priority: "medium", createdAt: Date.now() }]);
            setText("");
          }
        }} />
      </div>
      {goals.map((g, i) => (
        <div key={g.id} className="list-row" style={{ flexWrap: "wrap" }}>
          <div className="lr-title"><div className="t">{g.text}</div>{isGoalStalled(g) && <div className="s" style={{ color: "var(--warn)" }}>stalled — no recent activity</div>}</div>
          <select className="input" style={{ width: 90 }} value={g.priority} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, priority: e.target.value as Goal["priority"] } : x)))}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          <input className="input" style={{ width: 90 }} placeholder="metric" value={g.metric ?? ""} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, metric: e.target.value || undefined } : x)))} />
          <input className="input" style={{ width: 64 }} type="number" placeholder="now" value={g.current ?? ""} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, current: e.target.value === "" ? undefined : +e.target.value, lastActivity: Date.now() } : x)))} />
          <span className="hint">/</span>
          <input className="input" style={{ width: 64 }} type="number" placeholder="target" value={g.target ?? ""} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, target: e.target.value === "" ? undefined : +e.target.value } : x)))} />
          <button className="iconbtn" onClick={() => setGoals(goals.filter((_, j) => j !== i))}>🗑</button>
        </div>
      ))}
      {goals.length === 0 && <p className="hint">No goals yet. Goals power the autonomy loop, stall detection and weekly reports.</p>}
    </Modal>
  );
}

function ReportModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useStore((s) => s.toast);
  const run = async () => {
    setLoading(true);
    const r = await generateWeeklyReport(agent.id);
    setLoading(false);
    if (r) setReport(r);
    else toast("Couldn't generate the report — check your API key.", "err");
  };
  return (
    <Modal
      title={`${agent.emoji} ${agent.name} — weekly report`}
      onClose={onClose}
      wide
      footer={report ? <button className="btn" onClick={() => downloadText(`${agent.name}-weekly-report.md`, report, "text/markdown")}>⬇ Export .md</button> : undefined}
    >
      {!report && (
        <div style={{ textAlign: "center", padding: 20 }}>
          <p className="hint">Generates a report from this agent's real logged activity (completed tasks, goals, blockers) — nothing is fabricated.</p>
          <button className="btn primary" disabled={loading} onClick={() => void run()}>{loading ? "Writing report…" : "Generate report"}</button>
        </div>
      )}
      {report && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }} />}
    </Modal>
  );
}

function StatsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const messages = useStore((s) => s.messages);
  const st = agentStats(agent, messages);
  const fmtDur = (ms: number | null) =>
    ms === null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)} min`;
  const rows: [string, string][] = [
    ["Tasks completed (all time)", String(st.completedAllTime)],
    ["Tasks completed (this week)", String(st.completedThisWeek)],
    ["Avg task completion time", fmtDur(st.avgCompletionMs)],
    ["Initiatives self-started", String(st.initiativesStarted)],
    ["Currently blocked", String(st.blockedNow)],
    ["Reply ratings", `👍 ${st.ratingsUp} · 👎 ${st.ratingsDown}`],
    ["Learnings logged", String(st.learnings)],
  ];
  return (
    <Modal title={`${agent.emoji} ${agent.name} — performance`} onClose={onClose}>
      <p className="hint">Every number comes from logged events (task timestamps, your ratings) — nothing is estimated.</p>
      {rows.map(([k, v]) => (
        <div key={k} className="list-row" style={{ padding: 8 }}>
          <div className="lr-title"><div className="t">{k}</div></div>
          <b>{v}</b>
        </div>
      ))}
    </Modal>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const maxTasks = useStore((s) => s.settings.maxAgentTasks);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const [taskInput, setTaskInput] = useState("");
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const toast = useStore((s) => s.toast);

  const cap = agentCapacity(agent, maxTasks);
  const inProgress = agent.taskQueue.find((t) => t.status === "in_progress");
  const recent = [...agent.workday.tasksCompleted].reverse().slice(0, 3);
  const queue = agent.taskQueue.filter((t) => t.status !== "completed").slice(0, 6);

  const patchAgent = (patch: Partial<Agent>) => {
    const s = useStore.getState();
    useStore.setState({ agents: s.agents.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)) });
  };

  const assign = () => {
    const title = taskInput.trim();
    if (!title) return;
    setTaskInput("");
    const t = addAgentTask(agent.id, title);
    if (t && hasApiKey) void runAgentTask(agent.id, t.id);
    else if (!hasApiKey) toast("Task queued. Add your API key to let agents execute work.", "info");
  };

  return (
    <div className="card" style={{ gap: 10 }}>
      <div className="row">
        <span style={{ fontSize: 26 }}>{agent.emoji}</span>
        <div className="grow">
          <h3 style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {agent.name}
            <span className="status-dot" style={{ background: AVAIL_COLOR[cap.availability] }} title={cap.availability} />
          </h3>
          <div className="sub">{agent.role} · {cap.availability}</div>
        </div>
        <TaskRing pct={cap.pct} />
      </div>

      <div className="sub">
        <b>Currently:</b>{" "}
        {inProgress ? `working on "${inProgress.title}" (${(inProgress.streamedChars ?? 0).toLocaleString()} chars written)` : "idle — ready for a task"}
      </div>

      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" placeholder="Assign a task…" value={taskInput} onChange={(e) => setTaskInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && assign()} />
        <button className="btn sm primary" disabled={!taskInput.trim()} onClick={assign}>Assign</button>
      </div>

      {queue.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {queue.map((t) => (
            <div key={t.id} className="row" style={{ fontSize: 12, gap: 6 }}>
              <span className={"tag " + (t.status === "in_progress" ? "info" : t.status === "blocked" ? "err" : "")}>{t.status.replace("_", " ")}</span>
              <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
              {(t.status === "assigned" || t.status === "blocked") && (
                <button className="btn sm" onClick={() => void runAgentTask(agent.id, t.id)}>{t.status === "blocked" ? "Retry" : "▶ Run"}</button>
              )}
              <button className="iconbtn" style={{ width: 20, height: 20, fontSize: 11 }} onClick={() => deleteAgentTask(agent.id, t.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {agent.goals.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {agent.goals.slice(0, 3).map((g) => {
            const p = goalProgress(g);
            return (
              <div key={g.id} style={{ fontSize: 12 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🎯 {g.text}</span>
                  {isGoalStalled(g) && <span className="tag warn">stalled</span>}
                  {p !== null && <span className="hint">{p}%</span>}
                </div>
                {p !== null && <div className="progress-track"><div className="progress-fill" style={{ width: `${p}%` }} /></div>}
              </div>
            );
          })}
        </div>
      )}

      {recent.length > 0 && (
        <div className="sub">✅ Recent: {recent.map((r) => r.title).join(" · ").slice(0, 90)}</div>
      )}

      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => setGoalsOpen(true)}>🎯 Goals</button>
        <button className="btn sm" onClick={() => setReportOpen(true)}>📋 Weekly report</button>
        <button className="btn sm" onClick={() => setStatsOpen(true)}>📈 Stats</button>
        <button className="btn sm" title="Schedule recurring work for this agent" onClick={() => setScheduleOpen(true)}>🔁 Schedule</button>
        <select
          className="input" style={{ width: 150 }} value={agent.autonomyLevel}
          title="Autonomy: how much this agent may do without asking"
          onChange={(e) => patchAgent({ autonomyLevel: e.target.value as Agent["autonomyLevel"] })}
        >
          <option value="off">Autonomy: off</option>
          <option value="approval">Ask approval</option>
          <option value="auto">Auto (low-risk)</option>
        </select>
        <label className="checkbox-row" style={{ padding: 0 }} title="Periodic local checks raise alerts for stalled goals / overdue tasks">
          <input type="checkbox" checked={agent.proactiveMode} onChange={(e) => patchAgent({ proactiveMode: e.target.checked })} />
          proactive
        </label>
        {agent.autonomyLevel !== "off" && (
          <button
            className="btn sm"
            title="Run one think→decide→execute cycle now (1-2 API calls)"
            onClick={async () => {
              toast(`${agent.name} is thinking…`, "info");
              await runAutonomyCycle(agent.id);
            }}
          >
            🧠 Think now
          </button>
        )}
      </div>

      {goalsOpen && <GoalsModal agent={agent} onClose={() => setGoalsOpen(false)} />}
      {reportOpen && <ReportModal agent={agent} onClose={() => setReportOpen(false)} />}
      {statsOpen && <StatsModal agent={agent} onClose={() => setStatsOpen(false)} />}
      {scheduleOpen && <RecurringModal presetAgentId={agent.id} onClose={() => setScheduleOpen(false)} />}
    </div>
  );
}

export function AgentHubView() {
  const agents = useStore((s) => s.agents);
  const totalActive = agents.reduce((n, a) => n + activeTaskCount(a), 0);
  return (
    <div className="view-pad" style={{ maxWidth: 1280 }}>
      <div className="view-head">
        <h2>Agent Hub</h2>
        <span className="tag info">{totalActive} active tasks across the team</span>
      </div>
      <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(330px,1fr))" }}>
        {agents.map((a) => <AgentCard key={a.id} agent={a} />)}
      </div>
    </div>
  );
}
