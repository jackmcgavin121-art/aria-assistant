import { useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import type { KnowledgeDoc, MemoryRecord, BusinessProfile, CompanyMemory } from "../types";
import { parseFile, acceptedFileKinds } from "../features/files";
import { Modal, ConfirmModal } from "../components/Modal";
import { uid, fmtDate, plural } from "../lib/util";

/* ---------------- Documents tab ---------------- */

const CATEGORIES = ["General", "Products", "Customers", "Finance", "Legal", "Processes", "Marketing", "HR"];

function DocsTab() {
  const docs = useStore((s) => s.fileKnowledge);
  const agents = useStore((s) => s.agents);
  const toast = useStore((s) => s.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("All");
  const [viewing, setViewing] = useState<KnowledgeDoc | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return docs.filter(
      (d) =>
        (cat === "All" || d.category === cat) &&
        (!q || d.name.toLowerCase().includes(q) || d.content.toLowerCase().includes(q))
    );
  }, [docs, query, cat]);

  const addDocs = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const parsed = await parseFile(f);
        if (parsed.kind === "image") {
          toast(`${f.name}: images can be attached in chat, but can't be indexed as text knowledge.`, "err");
          continue;
        }
        const doc: KnowledgeDoc = {
          id: uid(),
          name: parsed.name,
          category: "General",
          content: parsed.text,
          truncated: parsed.truncated,
          originalChars: parsed.originalChars,
          type: parsed.kind,
          agentIds: [],
          addedAt: Date.now(),
        };
        const s = useStore.getState();
        useStore.setState({ fileKnowledge: [doc, ...s.fileKnowledge] });
        toast(`Added ${parsed.name}${parsed.truncated ? " (truncated — file was very large)" : ""}`, "ok");
      } catch (e: any) {
        toast(e.message, "err");
      }
    }
  };

  const addWebsite = async () => {
    const url = urlInput.trim();
    if (!/^https?:\/\//.test(url)) {
      toast("Enter a full URL starting with http(s)://", "err");
      return;
    }
    setBusy(true);
    const res = await window.aria.net.fetchText("https://r.jina.ai/" + url, { headers: { "x-return-format": "text" } });
    setBusy(false);
    if (!res.ok || !res.text) {
      toast("Couldn't read that page: " + (res.error ?? `HTTP ${res.status}`), "err");
      return;
    }
    const s = useStore.getState();
    useStore.setState({
      fileKnowledge: [
        {
          id: uid(),
          name: new URL(url).hostname + new URL(url).pathname,
          category: "General",
          content: res.text.slice(0, 200_000),
          truncated: res.text.length > 200_000,
          originalChars: res.text.length,
          type: "web",
          url,
          agentIds: [],
          addedAt: Date.now(),
        },
        ...s.fileKnowledge,
      ],
    });
    setUrlInput("");
    toast("Website content saved to knowledge", "ok");
  };

  const patchDoc = (id: string, patch: Partial<KnowledgeDoc>) => {
    const s = useStore.getState();
    useStore.setState({ fileKnowledge: s.fileKnowledge.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  };

  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      style={{ position: "relative", minHeight: 260 }}
      onDragEnter={(e) => e.dataTransfer.types.includes("Files") && setDragOver(true)}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void addDocs(e.dataTransfer.files);
      }}
    >
      {dragOver && <div className="drop-overlay">📄 Drop documents to add them to Knowledge</div>}
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <input ref={fileRef} type="file" hidden multiple accept={acceptedFileKinds()} onChange={(e) => { void addDocs(e.target.files); e.target.value = ""; }} />
        <button className="btn primary" onClick={() => fileRef.current?.click()}>⬆ Upload documents</button>
        <input className="input grow" style={{ maxWidth: 280 }} placeholder="Add a website URL…" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addWebsite()} />
        <button className="btn" disabled={busy || !urlInput.trim()} onClick={() => void addWebsite()}>{busy ? "Reading…" : "🌐 Add site"}</button>
        <span className="grow" />
        <input className="input" style={{ maxWidth: 220 }} placeholder="Search inside documents…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {["All", ...CATEGORIES].map((c) => (
          <button key={c} className={"chip" + (cat === c ? " on" : "")} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      {filtered.length === 0 && <p className="hint">No documents yet. Upload PDFs, Word docs, spreadsheets or text files — agents will use them to answer with your company's real information.</p>}
      {filtered.map((d) => (
        <div key={d.id} className="list-row">
          <span style={{ fontSize: 18 }}>{d.type === "pdf" ? "📕" : d.type === "docx" ? "📘" : d.type === "xlsx" ? "📗" : d.type === "web" ? "🌐" : "📄"}</span>
          <div className="lr-title">
            <div className="t">{d.name} {d.truncated && <span className="tag warn">truncated</span>}</div>
            <div className="s">{d.category} · {plural(Math.round(d.content.length / 1000), "k char")} · {fmtDate(d.addedAt)} · {d.agentIds.length ? `${d.agentIds.length} agents` : "all agents"}</div>
          </div>
          <select className="input" style={{ width: 120 }} value={d.category} onChange={(e) => patchDoc(d.id, { category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button className="btn sm" onClick={() => setViewing(d)}>Open</button>
          <button className="iconbtn" title="Delete" onClick={() => {
            const s = useStore.getState();
            useStore.setState({ fileKnowledge: s.fileKnowledge.filter((x) => x.id !== d.id) });
          }}>🗑</button>
        </div>
      ))}
      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)} wide>
          <label className="label">Visible to agents</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <button className={"chip" + (!viewing.agentIds.length ? " on" : "")} onClick={() => { patchDoc(viewing.id, { agentIds: [] }); setViewing({ ...viewing, agentIds: [] }); }}>All agents</button>
            {agents.map((a) => {
              const on = viewing.agentIds.includes(a.id);
              return (
                <button key={a.id} className={"chip" + (on ? " on" : "")} onClick={() => {
                  const next = on ? viewing.agentIds.filter((x) => x !== a.id) : [...viewing.agentIds, a.id];
                  patchDoc(viewing.id, { agentIds: next });
                  setViewing({ ...viewing, agentIds: next });
                }}>
                  {a.emoji} {a.name}
                </button>
              );
            })}
          </div>
          {viewing.truncated && <p className="hint">⚠ This document was larger than the 200k-character cap; only the first part was stored ({viewing.originalChars.toLocaleString()} chars originally).</p>}
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font)", fontSize: 13, lineHeight: 1.5, maxHeight: 380, overflow: "auto", background: "var(--bg2)", padding: 12, borderRadius: 8 }}>
            {viewing.content.slice(0, 20000)}{viewing.content.length > 20000 ? "\n\n… (preview capped at 20k chars)" : ""}
          </pre>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- Business profile tab ---------------- */

const PROFILE_FIELDS: { key: keyof BusinessProfile; label: string; ph: string }[] = [
  { key: "description", label: "What the business does", ph: "We make / provide…" },
  { key: "products", label: "Products & services", ph: "Main offerings, pricing tiers…" },
  { key: "customers", label: "Target customers", ph: "Who buys from you…" },
  { key: "keyAccounts", label: "Key accounts", ph: "Most important clients…" },
  { key: "competitors", label: "Competitors", ph: "Who you compete with…" },
  { key: "advantages", label: "Competitive advantages", ph: "Why customers pick you…" },
  { key: "team", label: "Team", ph: "Who does what…" },
  { key: "initiatives", label: "Current initiatives", ph: "What you're working on…" },
  { key: "notes", label: "Anything else", ph: "Other context agents should know…" },
];

function ProfileTab() {
  const bp = useStore((s) => s.businessProfile);
  const upd = (key: keyof BusinessProfile, value: string) => {
    const s = useStore.getState();
    useStore.setState({ businessProfile: { ...s.businessProfile, [key]: value } });
  };
  return (
    <div style={{ maxWidth: 640 }}>
      <p className="hint">Every agent knows this automatically — it's the shared company context injected into their prompts. Saves as you type.</p>
      {PROFILE_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="label">{f.label}</label>
          <textarea className="ta" rows={2} placeholder={f.ph} value={bp[f.key]} onChange={(e) => upd(f.key, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

/* ---------------- Records (mini-CRM) tab ---------------- */

const RECORD_KINDS: { key: keyof Omit<CompanyMemory, "learningLog">; label: string; icon: string; subKinds: string[] }[] = [
  { key: "customers", label: "Customers", icon: "🧑‍💼", subKinds: ["order", "ticket", "interaction", "note"] },
  { key: "products", label: "Products", icon: "📦", subKinds: ["fault", "service", "revision", "note"] },
  { key: "equipment", label: "Equipment", icon: "🛠", subKinds: ["service", "fault", "note"] },
  { key: "processes", label: "Processes", icon: "🔁", subKinds: ["step", "note"] },
  { key: "notes", label: "Notes", icon: "🗒", subKinds: ["note"] },
];

function RecordsTab() {
  const cm = useStore((s) => s.companyMemory);
  const [kind, setKind] = useState<(typeof RECORD_KINDS)[number]>(RECORD_KINDS[0]);
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [confirm, setConfirm] = useState<MemoryRecord | null>(null);

  const list = cm[kind.key];

  const saveRecord = (rec: MemoryRecord) => {
    const s = useStore.getState();
    const cur = s.companyMemory[kind.key];
    const exists = cur.some((r) => r.id === rec.id);
    useStore.setState({
      companyMemory: {
        ...s.companyMemory,
        [kind.key]: exists ? cur.map((r) => (r.id === rec.id ? { ...rec, updatedAt: Date.now() } : r)) : [{ ...rec }, ...cur],
      },
    });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {RECORD_KINDS.map((k) => (
          <button key={k.key} className={"chip" + (kind.key === k.key ? " on" : "")} onClick={() => setKind(k)}>
            {k.icon} {k.label} ({cm[k.key].length})
          </button>
        ))}
        <span className="grow" />
        <button className="btn sm primary" onClick={() => setEditing({ id: uid(), name: "", details: "", subRecords: [], createdAt: Date.now(), updatedAt: Date.now() })}>
          ＋ New {kind.label.replace(/s$/, "").toLowerCase()}
        </button>
      </div>
      {list.length === 0 && <p className="hint">No {kind.label.toLowerCase()} yet. Agents reference these records when answering.</p>}
      {list.map((r) => (
        <div key={r.id} className="list-row">
          <span>{kind.icon}</span>
          <div className="lr-title">
            <div className="t">{r.name}</div>
            <div className="s">{r.details.slice(0, 90)}{r.subRecords.length ? ` · ${plural(r.subRecords.length, "entry")}` : ""}</div>
          </div>
          <button className="btn sm" onClick={() => setEditing(r)}>Open</button>
          <button className="iconbtn" onClick={() => setConfirm(r)}>🗑</button>
        </div>
      ))}
      {editing && (
        <RecordModal
          record={editing}
          subKinds={kind.subKinds}
          onSave={(rec) => { saveRecord(rec); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={`Delete "${confirm.name}"?`}
          body="This record and its history entries will be removed."
          danger
          confirmLabel="Delete"
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const s = useStore.getState();
            useStore.setState({
              companyMemory: { ...s.companyMemory, [kind.key]: s.companyMemory[kind.key].filter((r) => r.id !== confirm.id) },
            });
          }}
        />
      )}
    </div>
  );
}

function RecordModal({ record, subKinds, onSave, onClose }: { record: MemoryRecord; subKinds: string[]; onSave: (r: MemoryRecord) => void; onClose: () => void }) {
  const [rec, setRec] = useState({ ...record, subRecords: [...record.subRecords] });
  const [subText, setSubText] = useState("");
  const [subKind, setSubKind] = useState(subKinds[0]);
  return (
    <Modal
      title={record.name || "New record"}
      onClose={onClose}
      wide
      footer={<button className="btn primary" disabled={!rec.name.trim()} onClick={() => onSave(rec)}>Save</button>}
    >
      <label className="label">Name</label>
      <input className="input" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} autoFocus />
      <label className="label">Details</label>
      <textarea className="ta" rows={4} value={rec.details} onChange={(e) => setRec({ ...rec, details: e.target.value })} />
      <label className="label">History ({rec.subRecords.length})</label>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="input" style={{ width: 130 }} value={subKind} onChange={(e) => setSubKind(e.target.value)}>
          {subKinds.map((k) => <option key={k}>{k}</option>)}
        </select>
        <input className="input grow" placeholder="Add an entry…" value={subText} onChange={(e) => setSubText(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Enter" && subText.trim()) {
            setRec({ ...rec, subRecords: [{ id: uid(), kind: subKind, text: subText.trim(), ts: Date.now() }, ...rec.subRecords] });
            setSubText("");
          }
        }} />
      </div>
      {rec.subRecords.map((sr) => (
        <div key={sr.id} className="list-row" style={{ padding: 8 }}>
          <span className="tag">{sr.kind}</span>
          <div className="lr-title"><div className="t">{sr.text}</div><div className="s">{fmtDate(sr.ts)}</div></div>
          <button className="iconbtn" onClick={() => setRec({ ...rec, subRecords: rec.subRecords.filter((x) => x.id !== sr.id) })}>🗑</button>
        </div>
      ))}
    </Modal>
  );
}

/* ---------------- Learning log tab ---------------- */

function LearningTab() {
  const log = useStore((s) => s.companyMemory.learningLog);
  const toast = useStore((s) => s.toast);
  return (
    <div>
      <p className="hint">
        Things you told ARIA to remember ("ARIA, remember…") or corrected ("Actually, that's wrong…") land here.
        Promote an entry to make it a permanent company note that all agents see.
      </p>
      {log.length === 0 && <p className="hint">Nothing logged yet.</p>}
      {log.map((e) => (
        <div key={e.id} className="list-row">
          <span className="tag" style={{ minWidth: 70, textAlign: "center" }}>{e.source}</span>
          <div className="lr-title">
            <div className="t">{e.text}</div>
            <div className="s">{fmtDate(e.ts)}{e.promoted ? " · promoted to notes" : ""}</div>
          </div>
          {!e.promoted && (
            <button className="btn sm" onClick={() => {
              const s = useStore.getState();
              useStore.setState({
                companyMemory: {
                  ...s.companyMemory,
                  notes: [{ id: uid(), name: e.text.slice(0, 60), details: e.text, subRecords: [], createdAt: Date.now(), updatedAt: Date.now() }, ...s.companyMemory.notes],
                  learningLog: s.companyMemory.learningLog.map((x) => (x.id === e.id ? { ...x, promoted: true } : x)),
                },
              });
              toast("Promoted to permanent notes", "ok");
            }}>↑ Promote</button>
          )}
          <button className="iconbtn" onClick={() => {
            const s = useStore.getState();
            useStore.setState({ companyMemory: { ...s.companyMemory, learningLog: s.companyMemory.learningLog.filter((x) => x.id !== e.id) } });
          }}>🗑</button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- main ---------------- */

export function KnowledgeView() {
  const [tab, setTab] = useState<"docs" | "profile" | "records" | "learning">("docs");
  const learnCount = useStore((s) => s.companyMemory.learningLog.filter((e) => !e.promoted).length);
  return (
    <div className="view-pad">
      <div className="view-head"><h2>Knowledge</h2></div>
      <div className="tabs">
        <button className={"tab" + (tab === "docs" ? " on" : "")} onClick={() => setTab("docs")}>📄 Documents</button>
        <button className={"tab" + (tab === "profile" ? " on" : "")} onClick={() => setTab("profile")}>🏢 Business profile</button>
        <button className={"tab" + (tab === "records" ? " on" : "")} onClick={() => setTab("records")}>🗂 Records</button>
        <button className={"tab" + (tab === "learning" ? " on" : "")} onClick={() => setTab("learning")}>💡 Learning log{learnCount ? ` (${learnCount})` : ""}</button>
      </div>
      {tab === "docs" && <DocsTab />}
      {tab === "profile" && <ProfileTab />}
      {tab === "records" && <RecordsTab />}
      {tab === "learning" && <LearningTab />}
    </div>
  );
}
