import { useMemo, useState } from "react";
import { useStore } from "../store/store";
import type { Agent } from "../types";
import { PERSONALITIES, INDUSTRY_TEMPLATES, TEAM_TEMPLATES, MODELS, agentFromPreset } from "../data/presets";
import { Modal, ConfirmModal } from "../components/Modal";
import { ContextMenu } from "../components/ContextMenu";
import { newConversation } from "../features/chat";
import { sendTeamMessage } from "../features/team";
import { uid } from "../lib/util";

/* ---------------- agent wizard (create + edit) ---------------- */

const WIZ_STEPS = ["Basics", "Personality", "Instructions", "Knowledge", "Review"];

function AgentWizard({ existing, onClose }: { existing?: Agent; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState(() =>
    existing
      ? { ...existing }
      : { ...agentFromPreset({ id: uid(), emoji: "🤖", name: "", role: "", instructions: "" }) }
  );
  const toast = useStore((s) => s.toast);

  const save = () => {
    const s = useStore.getState();
    if (!data.name.trim()) {
      toast("Give your agent a name", "err");
      setStep(0);
      return;
    }
    if (existing) {
      useStore.setState({ agents: s.agents.map((a) => (a.id === existing.id ? { ...a, ...data } : a)) });
      toast("Agent updated", "ok");
    } else {
      useStore.setState({ agents: [...s.agents, { ...data, id: uid() }] });
      toast(`${data.name} joined your team`, "ok");
    }
    onClose();
  };

  const upd = (patch: Partial<Agent>) => setData((d) => ({ ...d, ...patch }));

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "New agent"}
      onClose={onClose}
      wide
      footer={
        <>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>← Back</button>}
          <span className="grow" />
          {step < WIZ_STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>Next →</button>
          ) : (
            <button className="btn primary" onClick={save}>{existing ? "Save changes" : "Create agent"}</button>
          )}
        </>
      }
    >
      <div className="tabs">
        {WIZ_STEPS.map((sName, i) => (
          <button key={sName} className={"tab" + (i === step ? " on" : "")} onClick={() => setStep(i)}>
            {i + 1}. {sName}
          </button>
        ))}
      </div>

      {step === 0 && (
        <>
          <label className="label">Emoji</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["🤖", "🧑‍💼", "👩‍💻", "🏆", "📣", "🤝", "👥", "⚖️", "📊", "🎨", "🎧", "📈", "✍️", "🚀", "📦", "🔧", "🏥", "💡"].map((e) => (
              <button key={e} className={"chip" + (data.emoji === e ? " on" : "")} onClick={() => upd({ emoji: e })} style={{ fontSize: 16 }}>
                {e}
              </button>
            ))}
          </div>
          <label className="label">Name</label>
          <input className="input" value={data.name} onChange={(e) => upd({ name: e.target.value })} placeholder="e.g. Growth Marketer" />
          <label className="label">Role / department</label>
          <input className="input" value={data.role} onChange={(e) => upd({ role: e.target.value })} placeholder="e.g. Marketing" />
          <label className="label">Model</label>
          <select className="input" value={data.model ?? ""} onChange={(e) => upd({ model: e.target.value || undefined })}>
            <option value="">App default</option>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <p className="hint">Give heavyweight agents a stronger model and quick helpers a cheaper one — big lever on API cost.</p>
        </>
      )}

      {step === 1 && (
        <>
          <p className="hint">A personality appends a communication-style instruction to the agent's system prompt.</p>
          <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))" }}>
            <div className={"card clickable"} style={!data.personality ? { borderColor: "var(--ac)" } : undefined} onClick={() => upd({ personality: "" })}>
              <h3>— None</h3>
              <div className="sub">Default style</div>
            </div>
            {Object.entries(PERSONALITIES).map(([k, p]) => (
              <div key={k} className="card clickable" style={data.personality === k ? { borderColor: "var(--ac)" } : undefined} onClick={() => upd({ personality: k as Agent["personality"] })}>
                <h3>{p.icon} {p.label}</h3>
                <div className="sub">{p.desc}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <label className="label">Instructions (system prompt)</label>
          <textarea className="ta" rows={10} value={data.instructions} onChange={(e) => upd({ instructions: e.target.value })} placeholder="You are a … Help with …" />
          <p className="hint">Describe who this agent is, what they help with, and how they should respond.</p>
        </>
      )}

      {step === 3 && (
        <>
          <label className="label">Private knowledge (only this agent sees it)</label>
          <textarea className="ta" rows={10} value={data.knowledge} onChange={(e) => upd({ knowledge: e.target.value })} placeholder="Product details, pricing, procedures, terminology…" />
          <p className="hint">You can also upload documents in Knowledge and scope them to this agent.</p>
        </>
      )}

      {step === 4 && (
        <div>
          <h3 style={{ margin: "0 0 8px" }}>{data.emoji} {data.name || "(unnamed)"} <span className="tag">{data.role || "no role"}</span></h3>
          {data.personality && PERSONALITIES[data.personality] && (
            <p className="hint">Personality: {PERSONALITIES[data.personality].icon} {PERSONALITIES[data.personality].label}</p>
          )}
          <label className="label">Instructions</label>
          <p className="hint" style={{ whiteSpace: "pre-wrap" }}>{data.instructions || "(none)"}</p>
          {data.knowledge && (
            <>
              <label className="label">Knowledge</label>
              <p className="hint">{data.knowledge.length} characters of private knowledge</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ---------------- team mode launcher ---------------- */

function TeamModal({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const toast = useStore((s) => s.toast);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const applyTemplate = (roles: string[]) => {
    const ids: string[] = [];
    for (const role of roles) {
      const hit = agents.find((a) => a.role.toLowerCase().includes(role.toLowerCase()) && !ids.includes(a.id));
      if (hit) ids.push(hit.id);
    }
    if (ids.length < 2) toast("Not enough matching agents on your roster for that template", "err");
    setPicked(ids);
  };

  return (
    <Modal
      title="Team mode — ask several specialists at once"
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={picked.length < 2 || !message.trim()}
          onClick={() => {
            void sendTeamMessage(message.trim(), picked);
            onClose();
          }}
        >
          Send to {picked.length} agents
        </button>
      }
    >
      <label className="label">Quick templates</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TEAM_TEMPLATES.map((t) => (
          <button key={t.id} className="chip" onClick={() => applyTemplate(t.roles)}>
            {t.icon} {t.name}
          </button>
        ))}
      </div>
      <label className="label">Pick 2+ agents</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {agents.map((a) => (
          <button key={a.id} className={"chip" + (picked.includes(a.id) ? " on" : "")} onClick={() => toggle(a.id)}>
            {a.emoji} {a.name}
          </button>
        ))}
      </div>
      <label className="label">Your question</label>
      <textarea className="ta" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Should we raise our prices 10% next quarter?" />
    </Modal>
  );
}

/* ---------------- industry packs ---------------- */

function PacksModal({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  return (
    <Modal title="Industry packs" onClose={onClose} wide>
      <p className="hint">Add a ready-made team for your industry. Agents are added to your roster and fully editable.</p>
      <div className="card-grid">
        {INDUSTRY_TEMPLATES.map((pack) => (
          <div key={pack.id} className="card">
            <h3>{pack.icon} {pack.name}</h3>
            <div className="sub">{pack.desc}</div>
            <div className="sub">{pack.agents.map((a) => a.name).join(" · ")}</div>
            <button
              className="btn sm primary"
              onClick={() => {
                const s = useStore.getState();
                const existing = new Set(s.agents.map((a) => a.name));
                const fresh = pack.agents.filter((a) => !existing.has(a.name)).map((a) => agentFromPreset(a, "_" + uid().slice(0, 4)));
                if (!fresh.length) {
                  toast("Those agents are already on your roster", "info");
                  return;
                }
                useStore.setState({ agents: [...s.agents, ...fresh] });
                toast(`Added ${fresh.length} agents from ${pack.name}`, "ok");
              }}
            >
              Add {pack.agents.length} agents
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------- main view ---------------- */

export function AgentsView() {
  const agents = useStore((s) => s.agents);
  const conversations = useStore((s) => s.conversations);
  const [wizard, setWizard] = useState<{ open: boolean; agent?: Agent }>({ open: false });
  const [teamOpen, setTeamOpen] = useState(false);
  const [packsOpen, setPacksOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; agent: Agent } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const toast = useStore((s) => s.toast);

  const convCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of Object.values(conversations)) if (c.agentId && !c.deletedAt) counts[c.agentId] = (counts[c.agentId] ?? 0) + 1;
    return counts;
  }, [conversations]);

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Your AI team ({agents.length})</h2>
        <button className="btn" onClick={() => setPacksOpen(true)}>🏭 Industry packs</button>
        <button className="btn" onClick={() => setTeamOpen(true)}>👥 Team mode</button>
        <button className="btn primary" onClick={() => setWizard({ open: true })}>＋ New agent</button>
      </div>
      <div className="card-grid">
        {agents.map((a) => (
          <div
            key={a.id}
            className="card clickable"
            onClick={() => {
              useStore.setState({ activeAgentId: a.id });
              newConversation({ agentId: a.id });
            }}
          >
            <h3>
              <span style={{ fontSize: 22 }}>{a.emoji}</span> {a.name}
              {a.published && <span className="tag ac">shared</span>}
              {a.autonomyLevel !== "off" && <span className="tag info">autonomous</span>}
            </h3>
            <div className="sub">{a.role}</div>
            <div className="sub">
              {a.personality && PERSONALITIES[a.personality] ? `${PERSONALITIES[a.personality].icon} ${PERSONALITIES[a.personality].label} · ` : ""}
              {convCounts[a.id] ?? 0} chats · {a.taskQueue.filter((t) => t.status !== "completed").length} queued
            </div>
            <button
              className="iconbtn"
              style={{ position: "absolute", top: 8, right: 8 }}
              onClick={(e) => {
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, agent: a });
              }}
            >
              ⋯
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Chat", icon: "💬", onClick: () => { useStore.setState({ activeAgentId: menu.agent.id }); newConversation({ agentId: menu.agent.id }); } },
            { label: "Edit", icon: "✏️", onClick: () => setWizard({ open: true, agent: menu.agent }) },
            {
              label: "Duplicate", icon: "⧉",
              onClick: () => {
                const s = useStore.getState();
                useStore.setState({ agents: [...s.agents, { ...menu.agent, id: uid(), name: menu.agent.name + " (copy)", taskQueue: [], goals: [] }] });
              },
            },
            {
              label: menu.agent.published ? "Unshare (portal)" : "Share (portal)", icon: "🔗",
              onClick: () => {
                const s = useStore.getState();
                useStore.setState({ agents: s.agents.map((a) => (a.id === menu.agent.id ? { ...a, published: !a.published } : a)) });
                if (!menu.agent.published) toast("Agent shared — open it from the sidebar's Portal menu", "ok");
              },
            },
            { label: "Delete", icon: "🗑", danger: true, onClick: () => setConfirmDelete(menu.agent) },
          ]}
        />
      )}

      {wizard.open && <AgentWizard existing={wizard.agent} onClose={() => setWizard({ open: false })} />}
      {teamOpen && <TeamModal onClose={() => setTeamOpen(false)} />}
      {packsOpen && <PacksModal onClose={() => setPacksOpen(false)} />}
      {confirmDelete && (
        <ConfirmModal
          title={`Delete ${confirmDelete.name}?`}
          body="Their conversations stay in your history, but the agent, its queue and goals are removed."
          confirmLabel="Delete agent"
          danger
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const s = useStore.getState();
            useStore.setState({
              agents: s.agents.filter((a) => a.id !== confirmDelete.id),
              activeAgentId: s.activeAgentId === confirmDelete.id ? null : s.activeAgentId,
            });
          }}
        />
      )}
    </div>
  );
}
