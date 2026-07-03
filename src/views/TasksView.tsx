import { useMemo, useState } from "react";
import { useStore } from "../store/store";
import type { RecurringTaskDef, RecurFreq } from "../types";
import { addTask, toggleTask, deleteTask, addRecurring, deleteRecurring, computeNextDue } from "../features/tasks";
import { Modal } from "../components/Modal";
import { fmtDate, fmtDateTime } from "../lib/util";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function RecurringModal({ onClose, presetAgentId }: { onClose: () => void; presetAgentId?: string }) {
  const agents = useStore((s) => s.agents);
  const [title, setTitle] = useState("");
  const [freq, setFreq] = useState<RecurFreq>(presetAgentId ? "weekly" : "daily");
  const [days, setDays] = useState<number[]>([1]);
  const [intervalDays, setIntervalDays] = useState(3);
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [agentId, setAgentId] = useState(presetAgentId ?? "");
  const [autoExec, setAutoExec] = useState(!!presetAgentId);

  const preview = computeNextDue({ freq, days, intervalDays, timeOfDay, agentId: agentId || undefined, autoExec });

  return (
    <Modal
      title="New recurring task"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!title.trim()}
          onClick={() => {
            addRecurring({ title: title.trim(), freq, days: freq === "weekly" ? days : undefined, intervalDays: freq === "custom" ? intervalDays : undefined, timeOfDay, agentId: agentId || undefined, autoExec: autoExec && !!agentId });
            onClose();
          }}
        >
          Create schedule
        </button>
      }
    >
      <label className="label">Task</label>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Prepare weekly sales summary" autoFocus />
      <label className="label">Repeats</label>
      <div style={{ display: "flex", gap: 6 }}>
        {(["daily", "weekly", "monthly", "custom"] as RecurFreq[]).map((f) => (
          <button key={f} className={"chip" + (freq === f ? " on" : "")} onClick={() => setFreq(f)}>{f}</button>
        ))}
      </div>
      {freq === "weekly" && (
        <>
          <label className="label">On days</label>
          <div style={{ display: "flex", gap: 6 }}>
            {DOW.map((d, i) => (
              <button key={d} className={"chip" + (days.includes(i) ? " on" : "")} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}>{d}</button>
            ))}
          </div>
        </>
      )}
      {freq === "custom" && (
        <>
          <label className="label">Every N days</label>
          <input className="input" type="number" min={1} style={{ width: 100 }} value={intervalDays} onChange={(e) => setIntervalDays(Math.max(1, +e.target.value))} />
        </>
      )}
      <label className="label">At time</label>
      <input className="input" type="time" style={{ width: 130 }} value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
      <label className="label">Assign to agent (optional)</label>
      <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        <option value="">— No agent (just a reminder for me)</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
      </select>
      {agentId && (
        <label className="checkbox-row">
          <input type="checkbox" checked={autoExec} onChange={(e) => setAutoExec(e.target.checked)} />
          Auto-execute: the agent does the work each time it fires (uses API credits)
        </label>
      )}
      <p className="hint" style={{ marginTop: 12 }}>Next occurrence: <b>{fmtDateTime(preview)}</b></p>
    </Modal>
  );
}

type Filter = "all" | "open" | "done" | "overdue" | "recurring";

export function TasksView() {
  const tasks = useStore((s) => s.tasks);
  const recurring = useStore((s) => s.recurringTasks);
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const [filter, setFilter] = useState<Filter>("open");
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState("");
  const [autoExec, setAutoExec] = useState(false);
  const [recurOpen, setRecurOpen] = useState(false);

  const list = useMemo(() => {
    const now = Date.now();
    let l = tasks;
    if (filter === "open") l = l.filter((t) => !t.done);
    if (filter === "done") l = l.filter((t) => t.done);
    if (filter === "overdue") l = l.filter((t) => !t.done && t.due && t.due < now);
    return [...l].sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? Infinity) - (b.due ?? Infinity) || b.createdAt - a.createdAt);
  }, [tasks, filter]);

  const counts = {
    all: tasks.length,
    open: tasks.filter((t) => !t.done).length,
    done: tasks.filter((t) => t.done).length,
    overdue: tasks.filter((t) => !t.done && t.due && t.due < Date.now()).length,
    recurring: recurring.length,
  };

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Tasks</h2>
        <button className="btn" onClick={() => setRecurOpen(true)}>🔁 New recurring</button>
      </div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <input
          className="input grow"
          placeholder="Add a task… (Enter)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              addTask({ title: text.trim(), agentId: agentId || undefined, autoExec: autoExec && !!agentId });
              setText("");
            }
          }}
        />
        <select className="input" style={{ width: 190 }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Just for me</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
        </select>
        {agentId && (
          <label className="checkbox-row" title="Agent completes the work immediately via the API">
            <input type="checkbox" checked={autoExec} onChange={(e) => setAutoExec(e.target.checked)} />
            auto-execute
          </label>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {(["all", "open", "done", "overdue", "recurring"] as Filter[]).map((f) => (
          <button key={f} className={"chip" + (filter === f ? " on" : "")} onClick={() => setFilter(f)}>
            {f} ({counts[f]})
          </button>
        ))}
      </div>

      {filter === "recurring" ? (
        <div>
          {recurring.length === 0 && <p className="hint">No recurring schedules. They create real tasks automatically when due.</p>}
          {recurring.map((r: RecurringTaskDef) => (
            <div key={r.id} className="list-row">
              <span>🔁</span>
              <div className="lr-title">
                <div className="t">{r.title}</div>
                <div className="s">
                  {r.freq}{r.freq === "weekly" && r.days ? ` (${r.days.map((d) => DOW[d]).join(",")})` : ""}{r.freq === "custom" ? ` (every ${r.intervalDays}d)` : ""} at {r.timeOfDay ?? "09:00"} · next: {fmtDateTime(r.nextDueAt)}
                  {r.agentId ? ` · ${agents.find((a) => a.id === r.agentId)?.name ?? "agent"}${r.autoExec ? " (auto-executes)" : ""}` : ""}
                </div>
              </div>
              <button className="iconbtn" onClick={() => deleteRecurring(r.id)}>🗑</button>
            </div>
          ))}
        </div>
      ) : (
        <div>
          {list.length === 0 && <p className="hint">Nothing here. Add a task above, or let agents suggest them from chat replies.</p>}
          {list.map((t) => {
            const agent = agents.find((a) => a.id === t.agentId);
            const proj = t.projectId ? projects[t.projectId] : undefined;
            const overdue = !t.done && t.due && t.due < Date.now();
            return (
              <div key={t.id} className={"list-row" + (t.done ? " done" : "")}>
                <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} style={{ accentColor: "var(--ac)" }} />
                <div className="lr-title">
                  <div className="t">{t.title}</div>
                  <div className="s">
                    {agent ? `${agent.emoji} ${agent.name} · ` : ""}
                    {proj ? `${proj.emoji} ${proj.name} · ` : ""}
                    {t.recurringId ? "🔁 recurring · " : ""}
                    {t.due ? <span style={overdue ? { color: "var(--err)", fontWeight: 600 } : undefined}>due {fmtDate(t.due)}</span> : `added ${fmtDate(t.createdAt)}`}
                  </div>
                </div>
                {t.priority !== "medium" && <span className={"tag " + (t.priority === "high" ? "err" : "")}>{t.priority}</span>}
                <button className="iconbtn" onClick={() => deleteTask(t.id)}>🗑</button>
              </div>
            );
          })}
        </div>
      )}
      {recurOpen && <RecurringModal onClose={() => setRecurOpen(false)} />}
    </div>
  );
}
