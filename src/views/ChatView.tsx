import { useMemo, useRef, useState, useEffect } from "react";
import { useStore } from "../store/store";
import type { Conversation, Message } from "../types";
import {
  newConversation,
  openConversation,
  renameConversation,
  deleteConversation,
  togglePin,
  setConvFolder,
  sendMessage,
  stopStreaming,
  regenerateLast,
  rateMessage,
  suggestAgent,
  getAgent,
  summarizeAndContinue,
} from "../features/chat";
import { parseFile, acceptedFileKinds, type ParsedFile } from "../features/files";
import { renderMarkdown, markdownToText, handleMarkdownClick } from "../lib/markdown";
import { fmtDate, fmtTime, uid } from "../lib/util";
import { downloadText } from "../lib/download";
import { speak, stopSpeaking } from "../lib/tts";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { checkTaskSuggestion, addTask } from "../features/tasks";
import { maybeRunWebResearch } from "../features/webResearch";
import { ARTIFACT_TYPES, generateArtifact } from "../features/artifacts";

/* ---------------- conversation list ---------------- */

function groupLabel(c: Conversation): string {
  return fmtDate(c.updatedAt) || "Older";
}

function ConvList() {
  const conversations = useStore((s) => s.conversations);
  const folders = useStore((s) => s.folders);
  const activeConvId = useStore((s) => s.activeConvId);
  const agents = useStore((s) => s.agents);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const store = useStore.getState;

  const list = useMemo(() => {
    let all = Object.values(conversations);
    if (query.trim()) {
      const q = query.toLowerCase();
      const msgs = store().messages;
      all = all.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (msgs[c.id] ?? []).some((m) => m.content.toLowerCase().includes(q))
      );
    }
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations, query]);

  const pinned = list.filter((c) => c.pinned);
  const inFolders = new Map<string, Conversation[]>();
  const rest: Conversation[] = [];
  for (const c of list) {
    if (c.pinned) continue;
    if (c.folderId && folders[c.folderId]) {
      inFolders.set(c.folderId, [...(inFolders.get(c.folderId) ?? []), c]);
    } else rest.push(c);
  }
  const groups = new Map<string, Conversation[]>();
  for (const c of rest) {
    const g = groupLabel(c);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  const exportConv = (c: Conversation) => {
    const msgs = store().messages[c.id] ?? [];
    const md = `# ${c.title}\n\n` + msgs
      .map((m) => `**${m.role === "user" ? "You" : getAgent(m.agentId)?.name || "ARIA"}** (${new Date(m.ts).toLocaleString()}):\n\n${m.content}`)
      .join("\n\n---\n\n");
    downloadText(c.title.replace(/[^\w\- ]+/g, "").slice(0, 40) + ".md", md, "text/markdown");
  };

  const menuItems = (c: Conversation): MenuItem[] => [
    { label: c.pinned ? "Unpin" : "Pin", icon: "📌", onClick: () => togglePin(c.id) },
    {
      label: "Rename", icon: "✏️",
      onClick: () => {
        setRenaming(c.id);
        setRenameVal(c.title);
      },
    },
    {
      label: "Move to folder…", icon: "📁",
      onClick: () => {
        const name = window.prompt("Folder name (blank to remove from folder):", c.folderId ? folders[c.folderId]?.name : "");
        if (name === null) return;
        if (!name.trim()) {
          setConvFolder(c.id, undefined);
          return;
        }
        const s = store();
        let folder = Object.values(s.folders).find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
        if (!folder) {
          folder = { id: uid(), name: name.trim(), createdAt: Date.now() };
          useStore.setState({ folders: { ...s.folders, [folder.id]: folder } });
        }
        setConvFolder(c.id, folder.id);
      },
    },
    { label: "Export (.md)", icon: "⬇️", onClick: () => exportConv(c) },
    { label: "Summarize & continue", icon: "⏩", onClick: () => void summarizeAndContinue(c.id) },
    { label: "Delete", icon: "🗑", danger: true, onClick: () => deleteConversation(c.id) },
  ];

  const renderItem = (c: Conversation) => {
    const agent = agents.find((a) => a.id === c.agentId);
    return (
      <div
        key={c.id}
        className={"conv-item" + (c.id === activeConvId ? " on" : "")}
        onClick={() => openConversation(c.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, convId: c.id });
        }}
      >
        <span>{c.agentInitiated ? "🔔" : agent?.emoji ?? "💬"}</span>
        {renaming === c.id ? (
          <input
            className="input"
            style={{ padding: "2px 6px", fontSize: 13 }}
            value={renameVal}
            autoFocus
            onChange={(e) => setRenameVal(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                renameConversation(c.id, renameVal.trim() || c.title);
                setRenaming(null);
              }
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => {
              renameConversation(c.id, renameVal.trim() || c.title);
              setRenaming(null);
            }}
          />
        ) : (
          <span className="cv-title">{c.pinned ? "📌 " : ""}{c.title}</span>
        )}
        <button
          className="iconbtn cv-menu"
          style={{ width: 22, height: 22 }}
          onClick={(e) => {
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, convId: c.id });
          }}
        >
          ⋯
        </button>
      </div>
    );
  };

  const width = useStore((st) => st.settings.convListWidth);
  return (
    <div className="convlist" style={{ width, minWidth: width }}>
      <div className="convlist-head">
        <button className="btn primary" onClick={() => newConversation()}>＋ New chat</button>
        <input
          className="input"
          placeholder="Search conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="convlist-scroll">
        {pinned.length > 0 && <div className="conv-group">Pinned</div>}
        {pinned.map(renderItem)}
        {[...inFolders.entries()].map(([fid, convs]) => (
          <div key={fid}>
            <div className="conv-group">📁 {folders[fid]?.name}</div>
            {convs.map(renderItem)}
          </div>
        ))}
        {[...groups.entries()].map(([label, convs]) => (
          <div key={label}>
            <div className="conv-group">{label}</div>
            {convs.map(renderItem)}
          </div>
        ))}
        {list.length === 0 && <div className="hint" style={{ padding: 12 }}>No conversations yet.</div>}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(conversations[menu.convId])}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/* ---------------- panel resizer ---------------- */

function PanelResizer() {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={"panel-resizer" + (dragging ? " dragging" : "")}
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
        const startX = e.clientX;
        const startW = useStore.getState().settings.convListWidth;
        const move = (ev: MouseEvent) => {
          const w = Math.min(420, Math.max(190, startW + (ev.clientX - startX)));
          const s = useStore.getState();
          useStore.setState({ settings: { ...s.settings, convListWidth: w } });
        };
        const up = () => {
          setDragging(false);
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }}
    />
  );
}

/* ---------------- message row ---------------- */

function TeamTabs({ msg }: { msg: Message }) {
  const agents = useStore((s) => s.agents);
  const [tab, setTab] = useState(0);
  const rs = msg.teamResponses ?? [];
  const cur = rs[Math.min(tab, rs.length - 1)];
  return (
    <div>
      <div className="team-tabs">
        {rs.map((r, i) => {
          const a = agents.find((x) => x.id === r.agentId);
          return (
            <button key={r.agentId} className={"chip" + (i === tab ? " on" : "")} onClick={() => setTab(i)}>
              {a?.emoji ?? "🤖"} {a?.name ?? "Agent"}{r.error ? " ⚠" : ""}
            </button>
          );
        })}
      </div>
      {cur && (
        cur.error ? (
          <div className="tag err">Error: {cur.error}</div>
        ) : (
          <div className="md" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(cur.content || "…") }} />
        )
      )}
    </div>
  );
}

/** Edit a user message and resend: everything after it is discarded. */
function editAndResend(convId: string, msgId: string, newText: string) {
  const s = useStore.getState();
  const list = s.messages[convId] ?? [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  useStore.setState({ messages: { ...s.messages, [convId]: list.slice(0, idx) } });
  void sendMessage(newText, { convId });
}

function saveReplyToKnowledge(msg: Message, convTitle: string) {
  const s = useStore.getState();
  useStore.setState({
    companyMemory: {
      ...s.companyMemory,
      notes: [
        {
          id: uid(),
          name: `${convTitle} — saved reply`.slice(0, 60),
          details: msg.content,
          subRecords: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        ...s.companyMemory.notes,
      ],
    },
  });
  s.toast("Saved to Knowledge → Records → Notes", "ok");
}

function emailOut(msg: Message, convTitle: string) {
  const body = markdownToText(msg.content).slice(0, 1800);
  const href = `mailto:?subject=${encodeURIComponent(convTitle)}&body=${encodeURIComponent(body)}`;
  void window.aria.app.openExternal(href);
}

function MessageRow({ msg, convId, isLast, streaming }: { msg: Message; convId: string; isLast: boolean; streaming: boolean }) {
  const showTimestamps = useStore((s) => s.showTimestamps);
  const settings = useStore((s) => s.settings);
  const profile = useStore((s) => s.profile);
  const convTitle = useStore((s) => s.conversations[convId]?.title ?? "ARIA");
  const [speaking, setSpeaking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const agent = getAgent(msg.agentId);
  const isUser = msg.role === "user";
  const toast = useStore((s) => s.toast);

  const copy = () => {
    navigator.clipboard.writeText(msg.content);
    toast("Copied", "ok");
  };
  const readAloud = () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
    } else {
      speak(markdownToText(msg.content), settings.ttsVoice, settings.ttsRate, () => setSpeaking(false));
      setSpeaking(true);
    }
  };

  return (
    <div className={"msg" + (isUser ? " user" : "")}>
      <div className="avatar">{isUser ? (profile.name?.[0] || "U").toUpperCase() : agent?.emoji ?? "🤖"}</div>
      <div className="bubble">
        <div className="meta">
          <span className="who">{isUser ? profile.name || "You" : agent?.name ?? "ARIA"}</span>
          {showTimestamps && <span className="when">{fmtTime(msg.ts)}</span>}
          {msg.stopped && <span className="tag warn">stopped</span>}
        </div>
        {msg.attachments?.map((a, i) => (
          <div key={i} className="attach-pill" style={{ marginBottom: 4 }}>📎 {a.name}</div>
        ))}
        {editing ? (
          <div>
            <textarea className="ta" rows={3} value={editText} autoFocus onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setEditing(false); if (editText.trim()) editAndResend(convId, msg.id, editText.trim()); }
              if (e.key === "Escape") setEditing(false);
            }} />
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn sm primary" onClick={() => { setEditing(false); if (editText.trim()) editAndResend(convId, msg.id, editText.trim()); }}>Resend</button>
              <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
              <span className="hint">Replies after this point will be replaced.</span>
            </div>
          </div>
        ) : msg.teamResponses ? (
          <TeamTabs msg={msg} />
        ) : (
          <div className="md" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
        )}
        {streaming && isLast && !isUser && <span className="cursor-blink" />}
        {!!msg.webSources?.length && (
          <div className="source-badges">
            {msg.webSources.map((w, i) => (
              <a key={i} className="source-badge" onClick={() => window.aria.app.openExternal(w.url)} title={w.url}>
                🌐 {w.title || new URL(w.url).hostname}
              </a>
            ))}
          </div>
        )}
        {!isUser && !streaming && (
          <div className="msg-actions">
            <button className="iconbtn" title="Copy" onClick={copy}>⧉</button>
            <button className={"iconbtn" + (msg.rating === 1 ? " lit" : "")} title="Good response" onClick={() => rateMessage(convId, msg.id, 1)}>👍</button>
            <button className={"iconbtn" + (msg.rating === -1 ? " lit" : "")} title="Poor response" onClick={() => rateMessage(convId, msg.id, -1)}>👎</button>
            <button className={"iconbtn" + (speaking ? " lit" : "")} title="Read aloud" onClick={readAloud}>🔊</button>
            <button className="iconbtn" title="Save to knowledge" onClick={() => saveReplyToKnowledge(msg, convTitle)}>💾</button>
            <button className="iconbtn" title="Open in email app" onClick={() => emailOut(msg, convTitle)}>✉️</button>
            {isLast && (
              <button className="iconbtn" title="Regenerate" onClick={() => void regenerateLast(convId)}>↻</button>
            )}
          </div>
        )}
        {isUser && !streaming && !editing && (
          <div className="msg-actions">
            <button className="iconbtn" title="Edit & resend" onClick={() => { setEditText(msg.content); setEditing(true); }}>✏️</button>
            <button className="iconbtn" title="Copy" onClick={copy}>⧉</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- composer ---------------- */

const SLASH_COMMANDS = [
  { cmd: "/task", hint: "/task <title>", desc: "Add to your task list" },
  { cmd: "/remember", hint: "/remember <fact>", desc: "Save to the learning log" },
  { cmd: "/research", hint: "/research <question>", desc: "Answer with live web research" },
  { cmd: "/artifact", hint: "/artifact <type>", desc: "Generate a document from this chat (report, proposal, deck…)" },
];

/** Returns true if the text was consumed as a slash command. */
async function runSlashCommand(text: string, convId: string | null): Promise<boolean> {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return false;
  const [, cmd, rest] = m;
  const store = useStore.getState();
  if (cmd === "task") {
    if (!rest.trim()) { store.toast("Usage: /task <title>", "err"); return true; }
    addTask({ title: rest.trim() });
    store.toast("Task added", "ok");
    return true;
  }
  if (cmd === "remember") {
    if (!rest.trim()) { store.toast("Usage: /remember <fact>", "err"); return true; }
    useStore.setState({
      companyMemory: {
        ...store.companyMemory,
        learningLog: [
          { id: uid(), text: rest.trim(), source: "explicit" as const, ts: Date.now(), promoted: false },
          ...store.companyMemory.learningLog,
        ],
      },
    });
    store.toast("Noted in the learning log", "ok");
    return true;
  }
  if (cmd === "artifact") {
    const q = rest.trim().toLowerCase();
    const type = ARTIFACT_TYPES.find((t) => t.id === q || t.name.toLowerCase().includes(q)) ?? ARTIFACT_TYPES[0];
    void generateArtifact(type.id);
    return true;
  }
  if (cmd === "research") {
    if (!rest.trim()) { store.toast("Usage: /research <question>", "err"); return true; }
    const research = await maybeRunWebResearch(rest.trim(), true);
    await sendMessage(rest.trim(), {
      convId: convId ?? undefined,
      apiContentOverride: research?.prompt,
      webSources: research?.sources,
    });
    return true;
  }
  useStore.getState().toast(`Unknown command /${cmd} — try ${SLASH_COMMANDS.map((c) => c.cmd).join(", ")}`, "err");
  return true;
}

/** Set by the mounted Composer so drag-and-drop anywhere in the chat column attaches files. */
let externalFileDrop: ((files: FileList) => void) | null = null;

function Composer({ convId }: { convId: string | null }) {
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<ParsedFile[]>([]);
  const [suggestion, setSuggestion] = useState<ReturnType<typeof suggestAgent>>(null);
  const streamingConvId = useStore((s) => s.streamingConvId);
  const webResearchMode = useStore((s) => s.settings.webResearchMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useStore((s) => s.toast);
  const streaming = !!streamingConvId;

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  };

  const doSend = async () => {
    const t = text.trim();
    if (!t || streaming) return;
    const docs = attached.filter((a) => a.kind !== "image");
    const images = attached.filter((a) => a.kind === "image");
    setText("");
    setAttached([]);
    setSuggestion(null);
    if (taRef.current) taRef.current.style.height = "auto";

    if (t.startsWith("/") && (await runSlashCommand(t, convId))) return;

    const research = await maybeRunWebResearch(t);
    await sendMessage(t, {
      convId: convId ?? undefined,
      attachmentText: docs.map((d) => `--- ${d.name} ---\n${d.text}`).join("\n\n") || undefined,
      attachmentMeta: attached.length
        ? attached.map((a) => ({ name: a.name, kind: a.kind, chars: a.text.length }))
        : undefined,
      images: images.length ? images.map((i) => i.imageData!) : undefined,
      apiContentOverride: research?.prompt,
      webSources: research?.sources,
    });
    checkTaskSuggestion();
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const parsed = await parseFile(f);
        setAttached((prev) => [...prev, parsed]);
        if (parsed.truncated) toast(`${f.name} was truncated (too large) — first part attached.`, "info");
      } catch (e: any) {
        toast(e.message, "err");
      }
    }
  };

  useEffect(() => {
    externalFileDrop = (files) => void onPickFiles(files);
    return () => {
      externalFileDrop = null;
    };
  }, []);

  const conv = useStore((s) => (convId ? s.conversations[convId] : undefined));
  const lastMsg = useStore((s) => {
    const list = convId ? s.messages[convId] : undefined;
    return list?.[list.length - 1];
  });
  const slashMatches =
    text.startsWith("/") && !text.includes("\n")
      ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(text.split(" ")[0]))
      : [];

  return (
    <div className="composer-wrap">
      {conv?.agentInitiated && lastMsg?.role === "assistant" && !streaming && (
        <div className="revise-chips">
          {["Make it shorter", "Make it more formal", "Add more detail", "Simplify the language"].map((r) => (
            <button key={r} className="chip" onClick={() => void sendMessage(`Revise your last deliverable: ${r.toLowerCase()}.`, { convId: convId ?? undefined })}>
              ✏️ {r}
            </button>
          ))}
        </div>
      )}
      {slashMatches.length > 0 && (
        <div className="slash-hint">
          {slashMatches.map((c) => (
            <div key={c.cmd} className="row" onClick={() => { setText(c.cmd + " "); taRef.current?.focus(); }}>
              <code>{c.hint}</code>
              <span className="hint">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      {suggestion && (
        <div style={{ maxWidth: 780, margin: "0 auto 8px", display: "flex", gap: 8, alignItems: "center" }} className="hint">
          <span>💡 This looks like a job for <b>{suggestion.emoji} {suggestion.name}</b></span>
          <button
            className="btn sm"
            onClick={() => {
              useStore.setState({ activeAgentId: suggestion.id });
              setSuggestion(null);
            }}
          >
            Switch agent
          </button>
          <button className="btn sm ghost" onClick={() => setSuggestion(null)}>Dismiss</button>
        </div>
      )}
      <div className="composer">
        {attached.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 12px 0" }}>
            {attached.map((a, i) => (
              <span key={i} className="attach-pill">
                📎 {a.name}
                <button className="iconbtn" style={{ width: 18, height: 18, fontSize: 11 }} onClick={() => setAttached(attached.filter((_, j) => j !== i))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={webResearchMode ? "Message ARIA… (web research on)" : "Message ARIA…"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
            if (e.target.value.length > 12) setSuggestion(suggestAgent(e.target.value));
            else setSuggestion(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void doSend();
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept={acceptedFileKinds()}
            onChange={(e) => {
              void onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button className="iconbtn" title="Attach a document" onClick={() => fileRef.current?.click()}>📎</button>
          <span className="grow" />
          {streaming ? (
            <button className="btn danger sm" onClick={stopStreaming}>■ Stop</button>
          ) : (
            <button className="btn primary sm" disabled={!text.trim()} onClick={() => void doSend()}>Send ↵</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- empty state ---------------- */

function EmptyState() {
  const agents = useStore((s) => s.agents);
  const activeAgentId = useStore((s) => s.activeAgentId);
  const agent = agents.find((a) => a.id === activeAgentId);
  const starters = [
    "Draft a follow-up email to a client",
    "Summarise this week's priorities",
    "Help me plan next quarter",
    "Review a document for risks",
  ];
  return (
    <div className="empty-state">
      <div className="big">{agent?.emoji ?? "✦"}</div>
      <h2>{agent ? `${agent.name} is ready` : "Your AI team is ready"}</h2>
      <p style={{ margin: 0 }}>
        {agent ? agent.role : "Pick an agent from the top bar, or just start typing."}
      </p>
      <div className="suggest-strip">
        {starters.map((s) => (
          <button key={s} className="chip" onClick={() => void sendMessage(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- agent picker (top of thread) ---------------- */

export function AgentPicker() {
  const agents = useStore((s) => s.agents);
  const activeAgentId = useStore((s) => s.activeAgentId);
  const [open, setOpen] = useState(false);
  const agent = agents.find((a) => a.id === activeAgentId);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        {agent ? `${agent.emoji} ${agent.name}` : "🤖 Choose agent"} ▾
      </button>
      {open && (
        <Modal title="Choose an agent" onClose={() => setOpen(false)} wide>
          <div className="card-grid">
            {agents.map((a) => (
              <div
                key={a.id}
                className={"card clickable"}
                style={a.id === activeAgentId ? { borderColor: "var(--ac)" } : undefined}
                onClick={() => {
                  useStore.setState({ activeAgentId: a.id });
                  setOpen(false);
                }}
              >
                <h3><span style={{ fontSize: 20 }}>{a.emoji}</span> {a.name}</h3>
                <div className="sub">{a.role}</div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ---------------- main view ---------------- */

export function ChatView() {
  const activeConvId = useStore((s) => s.activeConvId);
  const messages = useStore((s) => (s.activeConvId ? s.messages[s.activeConvId] : undefined));
  const streamingConvId = useStore((s) => s.streamingConvId);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const list = messages ?? [];
  const streaming = !!streamingConvId && streamingConvId === activeConvId;

  return (
    <div className="chat-wrap">
      <ConvList />
      <PanelResizer />
      <div
        className="thread-col"
        style={{ position: "relative" }}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            dragDepth.current++;
            setDragOver(true);
          }
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          if (e.dataTransfer.files.length) externalFileDrop?.(e.dataTransfer.files);
        }}
      >
        {dragOver && <div className="drop-overlay">📎 Drop files to attach</div>}
        {activeConvId && list.length > 0 ? (
          <div className="thread" ref={threadRef} onScroll={onScroll}>
            <div className="thread-inner">
              {list.map((m, i) => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  convId={activeConvId}
                  isLast={i === list.length - 1}
                  streaming={streaming}
                />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState />
        )}
        <Composer convId={activeConvId} />
      </div>
    </div>
  );
}
