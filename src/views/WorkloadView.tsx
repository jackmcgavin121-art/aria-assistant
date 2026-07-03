import { useState } from "react";
import { useStore } from "../store/store";
import type { Agent, AgentTask } from "../types";
import { agentCapacity, runAgentTask, activeTaskCount, handOffTask } from "../features/agentExec";
import { openConversation } from "../features/chat";
import { fmtDateTime, clamp } from "../lib/util";
import { Modal } from "../components/Modal";

const AVAIL_COLOR: Record<string, string> = {
  available: "var(--ok)",
  busy: "var(--warn)",
  overloaded: "var(--err)",
};

interface Row {
  agent: Agent;
  task: AgentTask;
}

function allTasks(agents: Agent[]): Row[] {
  return agents.flatMap((agent) => agent.taskQueue.map((task) => ({ agent, task })));
}

/**
 * Honest in-flight progress: characters streamed so far against a soft
 * expectation (~6k chars ≈ a full 2k-token deliverable). Never shows 100%
 * until the API call actually finishes.
 */
function streamPct(t: AgentTask): number {
  return clamp(Math.round(((t.streamedChars ?? 0) / 6000) * 90), 3, 90);
}

function HandoffModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const agents = useStore((s) => s.agents.filter((a) => a.id !== row.agent.id));
  const [instruction, setInstruction] = useState("");
  return (
    <Modal title={`Hand off "${row.task.title}"`} onClose={onClose}>
      <label className="label">Instruction for the next agent (optional)</label>
      <input className="input" placeholder="e.g. Review for legal risks" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      <label className="label">Hand to</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {agents.map((a) => (
          <button key={a.id} className="chip" onClick={() => { handOffTask(row.agent.id, row.task.id, a.id, instruction.trim() || undefined); onClose(); }}>
            {a.emoji} {a.name}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function TasksBoard() {
  const agents = useStore((s) => s.agents);
  const [handoff, setHandoff] = useState<Row | null>(null);
  const rows = allTasks(agents);
  const inProgress = rows.filter((r) => r.task.status === "in_progress");
  const queued = rows.filter((r) => r.task.status === "assigned" || r.task.status === "blocked");
  const done = rows
    .filter((r) => r.task.status === "completed")
    .sort((a, b) => (b.task.completedAt ?? 0) - (a.task.completedAt ?? 0))
    .slice(0, 12);

  return (
    <div>
      <h3 style={{ margin: "8px 0" }}>In progress ({inProgress.length})</h3>
      {inProgress.length === 0 && <p className="hint">Nothing running right now.</p>}
      {inProgress.map(({ agent, task }) => (
        <div key={task.id} className="list-row">
          <span style={{ fontSize: 18 }}>{agent.emoji}</span>
          <div className="lr-title">
            <div className="t">{task.title}</div>
            <div className="s">{agent.name} · {(task.streamedChars ?? 0).toLocaleString()} chars streamed</div>
            <div className="progress-track" style={{ marginTop: 4 }}><div className="progress-fill" style={{ width: `${streamPct(task)}%` }} /></div>
          </div>
        </div>
      ))}

      <h3 style={{ margin: "16px 0 8px" }}>Queued & blocked ({queued.length})</h3>
      {queued.length === 0 && <p className="hint">Queue is clear.</p>}
      {queued.map(({ agent, task }) => (
        <div key={task.id} className="list-row">
          <span style={{ fontSize: 18 }}>{agent.emoji}</span>
          <div className="lr-title">
            <div className="t">{task.title} {task.status === "blocked" && <span className="tag err">blocked</span>}</div>
            <div className="s">{agent.name}{task.blockers?.length ? ` · ${task.blockers[0]}` : ""}{task.due ? ` · due ${fmtDateTime(task.due)}` : ""}</div>
          </div>
          <button className="btn sm" onClick={() => void runAgentTask(agent.id, task.id)}>{task.status === "blocked" ? "Retry" : "▶ Run now"}</button>
        </div>
      ))}

      <h3 style={{ margin: "16px 0 8px" }}>Recently completed</h3>
      {done.length === 0 && <p className="hint">Completed agent tasks will appear here with their deliverables.</p>}
      {done.map(({ agent, task }) => (
        <div key={task.id} className="list-row">
          <span style={{ fontSize: 18 }}>{agent.emoji}</span>
          <div className="lr-title">
            <div className="t">✅ {task.title}</div>
            <div className="s">{agent.name} · {fmtDateTime(task.completedAt)}</div>
          </div>
          {task.convId && <button className="btn sm" onClick={() => openConversation(task.convId!)}>View result</button>}
          <button className="btn sm" title="Hand the deliverable to another agent" onClick={() => setHandoff({ agent, task })}>🤝 Hand off</button>
        </div>
      ))}
      {handoff && <HandoffModal row={handoff} onClose={() => setHandoff(null)} />}
    </div>
  );
}

function CapacityTable() {
  const agents = useStore((s) => s.agents);
  const maxTasks = useStore((s) => s.settings.maxAgentTasks);
  const setMax = (n: number) => {
    const s = useStore.getState();
    useStore.setState({ settings: { ...s.settings, maxAgentTasks: clamp(n, 1, 20) } });
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="hint">Capacity per agent:</span>
        <input className="input" type="number" min={1} max={20} style={{ width: 70 }} value={maxTasks} onChange={(e) => setMax(+e.target.value)} />
        <span className="hint">active tasks = 100%</span>
      </div>
      {agents.map((a) => {
        const cap = agentCapacity(a, maxTasks);
        const active = activeTaskCount(a);
        const doneCount = a.workday.tasksCompleted.length;
        return (
          <div key={a.id} className="list-row">
            <span style={{ fontSize: 18 }}>{a.emoji}</span>
            <div className="lr-title" style={{ maxWidth: 220 }}>
              <div className="t">{a.name}</div>
              <div className="s">{a.role}</div>
            </div>
            <div className="grow">
              <div className="progress-track"><div className="progress-fill" style={{ width: `${cap.pct}%`, background: AVAIL_COLOR[cap.availability] }} /></div>
            </div>
            <span className="tag" style={{ minWidth: 88, textAlign: "center", color: AVAIL_COLOR[cap.availability] }}>{cap.availability}</span>
            <span className="hint" style={{ minWidth: 130 }}>{active} active · {doneCount} done all-time</span>
          </div>
        );
      })}
    </div>
  );
}

export function WorkloadView() {
  const [tab, setTab] = useState<"tasks" | "capacity">("tasks");
  return (
    <div className="view-pad">
      <div className="view-head"><h2>Workload</h2></div>
      <div className="tabs">
        <button className={"tab" + (tab === "tasks" ? " on" : "")} onClick={() => setTab("tasks")}>Tasks in progress</button>
        <button className={"tab" + (tab === "capacity" ? " on" : "")} onClick={() => setTab("capacity")}>Team capacity</button>
      </div>
      {tab === "tasks" ? <TasksBoard /> : <CapacityTable />}
    </div>
  );
}
