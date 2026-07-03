import { useState } from "react";
import { useStore } from "../store/store";
import type { Project } from "../types";
import { PROJECT_COLORS } from "../store/defaults";
import { Modal, ConfirmModal } from "../components/Modal";
import { uid, fmtDate } from "../lib/util";
import { newConversation, openConversation } from "../features/chat";
import { addTask, toggleTask, deleteTask } from "../features/tasks";

function ProjectModal({ existing, onClose }: { existing?: Project; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [p, setP] = useState<Project>(
    existing ?? {
      id: uid(),
      name: "",
      emoji: "📁",
      color: PROJECT_COLORS[0],
      description: "",
      agentIds: [],
      notes: "",
      knowledge: "",
      createdAt: Date.now(),
    }
  );
  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "New project"}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!p.name.trim()}
          onClick={() => {
            const s = useStore.getState();
            useStore.setState({ projects: { ...s.projects, [p.id]: p } });
            onClose();
          }}
        >
          {existing ? "Save" : "Create project"}
        </button>
      }
    >
      <div className="row">
        <div>
          <label className="label">Emoji</label>
          <input className="input" style={{ width: 64, textAlign: "center" }} value={p.emoji} onChange={(e) => setP({ ...p, emoji: e.target.value })} />
        </div>
        <div className="grow">
          <label className="label">Name</label>
          <input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} autoFocus />
        </div>
      </div>
      <label className="label">Colour</label>
      <div style={{ display: "flex", gap: 8 }}>
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setP({ ...p, color: c })}
            style={{
              width: 26, height: 26, borderRadius: 999, background: c, cursor: "pointer",
              border: p.color === c ? "3px solid var(--tx)" : "3px solid transparent",
            }}
          />
        ))}
      </div>
      <label className="label">Description</label>
      <textarea className="ta" rows={3} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
      <label className="label">Agents on this project</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {agents.map((a) => {
          const on = p.agentIds.includes(a.id);
          return (
            <button key={a.id} className={"chip" + (on ? " on" : "")} onClick={() => setP({ ...p, agentIds: on ? p.agentIds.filter((x) => x !== a.id) : [...p.agentIds, a.id] })}>
              {a.emoji} {a.name}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function ProjectWorkspace({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const project = useStore((s) => s.projects[projectId]);
  const conversations = useStore((s) => s.conversations);
  const tasks = useStore((s) => s.tasks);
  const artifacts = useStore((s) => s.artifacts);
  const [tab, setTab] = useState<"convs" | "notes" | "tasks" | "knowledge" | "docs">("convs");
  const [newTask, setNewTask] = useState("");
  const [edit, setEdit] = useState(false);
  if (!project) return null;

  const patch = (patchObj: Partial<Project>) => {
    const s = useStore.getState();
    useStore.setState({ projects: { ...s.projects, [projectId]: { ...s.projects[projectId], ...patchObj } } });
  };

  const projConvs = Object.values(conversations).filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
  const projTasks = tasks.filter((t) => t.projectId === projectId);
  const projArtifacts = Object.values(artifacts).filter((a) => a.projectId === projectId);

  return (
    <div className="view-pad">
      <div className="view-head">
        <button className="btn ghost" onClick={onBack}>← Projects</button>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 99, background: project.color, display: "inline-block" }} />
          {project.emoji} {project.name}
        </h2>
        <button className="btn" onClick={() => setEdit(true)}>Edit</button>
        <button className="btn primary" onClick={() => newConversation({ projectId, agentId: project.agentIds[0] ?? null })}>＋ Chat in project</button>
      </div>
      {project.description && <p className="hint" style={{ marginTop: -12 }}>{project.description}</p>}
      <div className="tabs">
        <button className={"tab" + (tab === "convs" ? " on" : "")} onClick={() => setTab("convs")}>💬 Conversations ({projConvs.length})</button>
        <button className={"tab" + (tab === "tasks" ? " on" : "")} onClick={() => setTab("tasks")}>☑ Tasks ({projTasks.filter((t) => !t.done).length})</button>
        <button className={"tab" + (tab === "notes" ? " on" : "")} onClick={() => setTab("notes")}>🗒 Notes</button>
        <button className={"tab" + (tab === "knowledge" ? " on" : "")} onClick={() => setTab("knowledge")}>📚 Knowledge</button>
        <button className={"tab" + (tab === "docs" ? " on" : "")} onClick={() => setTab("docs")}>📄 Documents ({projArtifacts.length})</button>
      </div>

      {tab === "convs" && (
        <div>
          {projConvs.length === 0 && <p className="hint">No conversations in this project yet.</p>}
          {projConvs.map((c) => (
            <div key={c.id} className="list-row" style={{ cursor: "pointer" }} onClick={() => openConversation(c.id)}>
              <span>💬</span>
              <div className="lr-title"><div className="t">{c.title}</div><div className="s">{fmtDate(c.updatedAt)}</div></div>
            </div>
          ))}
        </div>
      )}
      {tab === "tasks" && (
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="input grow" placeholder="Add a task to this project…" value={newTask} onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && newTask.trim()) {
                addTask({ title: newTask.trim(), projectId });
                setNewTask("");
              }
            }} />
          </div>
          {projTasks.map((t) => (
            <div key={t.id} className={"list-row" + (t.done ? " done" : "")}>
              <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} style={{ accentColor: "var(--ac)" }} />
              <div className="lr-title"><div className="t">{t.title}</div></div>
              <button className="iconbtn" onClick={() => deleteTask(t.id)}>🗑</button>
            </div>
          ))}
        </div>
      )}
      {tab === "notes" && (
        <textarea className="ta" rows={14} placeholder="Project notes… (saved as you type; agents in project chats see these)" value={project.notes} onChange={(e) => patch({ notes: e.target.value })} />
      )}
      {tab === "knowledge" && (
        <>
          <p className="hint">Injected into every conversation inside this project.</p>
          <textarea className="ta" rows={14} placeholder="Project-specific context, specs, briefs…" value={project.knowledge} onChange={(e) => patch({ knowledge: e.target.value })} />
        </>
      )}
      {tab === "docs" && (
        <div>
          {projArtifacts.length === 0 && <p className="hint">Documents generated from project chats will appear here.</p>}
          {projArtifacts.map((a) => (
            <div key={a.id} className="list-row">
              <span>📄</span>
              <div className="lr-title"><div className="t">{a.title}</div><div className="s">{a.type} · {fmtDate(a.createdAt)}</div></div>
            </div>
          ))}
        </div>
      )}
      {edit && <ProjectModal existing={project} onClose={() => setEdit(false)} />}
    </div>
  );
}

export function ProjectsView() {
  const projects = useStore((s) => s.projects);
  const conversations = useStore((s) => s.conversations);
  const tasks = useStore((s) => s.tasks);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Project | null>(null);

  if (openId && projects[openId]) return <ProjectWorkspace projectId={openId} onBack={() => setOpenId(null)} />;

  const list = Object.values(projects).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Projects</h2>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ New project</button>
      </div>
      <div className="card-grid">
        {list.map((p) => {
          const convs = Object.values(conversations).filter((c) => c.projectId === p.id).length;
          const open = tasks.filter((t) => t.projectId === p.id && !t.done).length;
          return (
            <div key={p.id} className="card clickable" onClick={() => setOpenId(p.id)} style={{ borderTop: `3px solid ${p.color}` }}>
              <h3><span style={{ fontSize: 20 }}>{p.emoji}</span> {p.name}</h3>
              {p.description && <div className="sub">{p.description.slice(0, 80)}</div>}
              <div className="sub">{convs} chats · {open} open tasks</div>
              <button className="iconbtn" style={{ position: "absolute", top: 8, right: 8 }} onClick={(e) => { e.stopPropagation(); setConfirm(p); }}>🗑</button>
            </div>
          );
        })}
        <div className="card clickable" style={{ alignItems: "center", justifyContent: "center", minHeight: 110, color: "var(--tx3)" }} onClick={() => setCreating(true)}>
          <div style={{ fontSize: 26 }}>＋</div>
          <div>New project</div>
        </div>
      </div>
      {creating && <ProjectModal onClose={() => setCreating(false)} />}
      {confirm && (
        <ConfirmModal
          title={`Delete project "${confirm.name}"?`}
          body="Conversations and tasks in it are kept but unlinked from the project."
          danger
          confirmLabel="Delete project"
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const s = useStore.getState();
            const projectsNext = { ...s.projects };
            delete projectsNext[confirm.id];
            useStore.setState({
              projects: projectsNext,
              conversations: Object.fromEntries(
                Object.entries(s.conversations).map(([id, c]) => [id, c.projectId === confirm.id ? { ...c, projectId: undefined } : c])
              ),
              tasks: s.tasks.map((t) => (t.projectId === confirm.id ? { ...t, projectId: undefined } : t)),
            });
          }}
        />
      )}
    </div>
  );
}
