import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import { Modal } from "../components/Modal";
import { openConversation, newConversation } from "../features/chat";
import { fmtDate } from "../lib/util";
import type { ViewId } from "../types";

interface Hit {
  icon: string;
  title: string;
  sub: string;
  go: () => void;
}

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const s = useStore();
  const mode = s.searchMode;
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ searchOpen: false });

  const hits = useMemo((): Hit[] => {
    const query = q.trim().toLowerCase();
    const out: Hit[] = [];
    const push = (h: Hit) => out.length < 30 && out.push(h);

    // Ctrl+P mode: recent conversations, no query needed.
    if (mode === "convs") {
      const recent = Object.values(s.conversations)
        .filter((c) => !query || c.title.toLowerCase().includes(query))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 15);
      for (const c of recent) {
        const agent = s.agents.find((a) => a.id === c.agentId);
        push({
          icon: agent?.emoji ?? "💬",
          title: c.title,
          sub: `${agent?.name ?? "conversation"} · ${fmtDate(c.updatedAt)}`,
          go: () => { openConversation(c.id); close(); },
        });
      }
      return out;
    }

    // Actions first — the palette does things, not just finds them.
    const go = (view: ViewId) => () => { useStore.setState({ view }); close(); };
    const actions: Hit[] = [
      { icon: "＋", title: "New chat", sub: "action", go: () => { newConversation(); close(); } },
      { icon: s.darkMode ? "☀️" : "🌙", title: "Toggle dark mode", sub: "action", go: () => { useStore.setState({ darkMode: !s.darkMode }); close(); } },
      { icon: "⚙️", title: "Open Settings", sub: "action", go: () => { useStore.setState({ settingsOpen: true }); close(); } },
      { icon: "🔑", title: "Set API key", sub: "action · Settings → AI & API", go: () => { useStore.setState({ settingsOpen: true, settingsTab: "ai" }); close(); } },
      { icon: "🔔", title: "Open alerts", sub: "action", go: () => { useStore.setState({ alertsOpen: true }); close(); } },
      { icon: "💬", title: "Go to Chat", sub: "action", go: go("chat") },
      { icon: "🤖", title: "Go to Agents", sub: "action", go: go("agents") },
      { icon: "📚", title: "Go to Knowledge", sub: "action", go: go("knowledge") },
      { icon: "📁", title: "Go to Projects", sub: "action", go: go("projects") },
      { icon: "☑️", title: "Go to Tasks", sub: "action", go: go("tasks") },
      { icon: "🎯", title: "Go to Agent Hub", sub: "action", go: go("agenthub") },
      { icon: "📊", title: "Go to Workload", sub: "action", go: go("workload") },
      ...s.agents.map((a) => ({
        icon: a.emoji,
        title: `New chat with ${a.name}`,
        sub: "action · " + a.role,
        go: () => { useStore.setState({ activeAgentId: a.id }); newConversation({ agentId: a.id }); close(); },
      })),
    ];
    if (query.length >= 2) {
      for (const a of actions) if (a.title.toLowerCase().includes(query)) push(a);
    }

    if (query.length < 2) return out;

    for (const c of Object.values(s.conversations)) {
      const inTitle = c.title.toLowerCase().includes(query);
      const inBody = (s.messages[c.id] ?? []).some((m) => m.content.toLowerCase().includes(query));
      if (inTitle || inBody)
        push({ icon: "💬", title: c.title, sub: inBody && !inTitle ? "matched message content" : "conversation", go: () => { openConversation(c.id); close(); } });
    }
    for (const a of s.agents)
      if ((a.name + " " + a.role).toLowerCase().includes(query))
        push({ icon: a.emoji, title: a.name, sub: a.role, go: () => { useStore.setState({ view: "agents" }); close(); } });
    for (const d of s.fileKnowledge)
      if (d.name.toLowerCase().includes(query) || d.content.toLowerCase().includes(query))
        push({ icon: "📄", title: d.name, sub: "knowledge document", go: () => { useStore.setState({ view: "knowledge" }); close(); } });
    for (const p of Object.values(s.projects))
      if (p.name.toLowerCase().includes(query))
        push({ icon: p.emoji, title: p.name, sub: "project", go: () => { useStore.setState({ view: "projects" }); close(); } });
    for (const t of s.tasks)
      if (t.title.toLowerCase().includes(query))
        push({ icon: t.done ? "✅" : "☑️", title: t.title, sub: "task", go: () => { useStore.setState({ view: "tasks" }); close(); } });
    for (const key of ["customers", "products", "equipment", "processes", "notes"] as const)
      for (const r of s.companyMemory[key])
        if ((r.name + " " + r.details).toLowerCase().includes(query))
          push({ icon: "🗂", title: r.name, sub: key, go: () => { useStore.setState({ view: "knowledge" }); close(); } });
    return out;
  }, [q, s, mode]);

  useEffect(() => setSel(0), [q, mode]);
  useEffect(() => {
    listRef.current?.querySelector(".list-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <Modal title={mode === "convs" ? "Recent conversations" : "Search & commands"} onClose={close}>
      <input
        className="input"
        placeholder={mode === "convs" ? "Filter conversations…" : "Search or type a command… (chats, agents, docs, actions)"}
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => Math.min(v + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => Math.max(v - 1, 0)); }
          else if (e.key === "Enter") hits[sel]?.go();
        }}
      />
      <div style={{ marginTop: 12, maxHeight: 380, overflow: "auto" }} ref={listRef}>
        {mode === "all" && q.trim().length < 2 && <p className="hint">Type to search everything — or try "new chat with", "dark mode", "go to tasks"…</p>}
        {q.trim().length >= 2 && hits.length === 0 && <p className="hint">No matches.</p>}
        {hits.map((h, i) => (
          <div key={i} className={"list-row" + (i === sel ? " sel" : "")} style={{ cursor: "pointer" }} onClick={h.go} onMouseEnter={() => setSel(i)}>
            <span>{h.icon}</span>
            <div className="lr-title"><div className="t">{h.title}</div><div className="s">{h.sub}</div></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
