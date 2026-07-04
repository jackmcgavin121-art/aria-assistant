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
  branchConversation,
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
  const [folderPick, setFolderPick] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const store = useStore.getState;

  const list = useMemo(() => {
    let all = Object.values(conversations).filter((c) => !c.deletedAt);
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

  const exportPdf = async (c: Conversation) => {
    if (!window.aria.app.exportPdf) {
      store().toast("PDF export is only available in the installed app.", "info");
      return;
    }
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const msgs = store().messages[c.id] ?? [];
    const body = msgs
      .map(
        (m) =>
          `<div class="m"><div class="who">${esc(m.role === "user" ? "You" : getAgent(m.agentId)?.name || "ARIA")} — ${esc(new Date(m.ts).toLocaleString())}</div>${renderMarkdown(m.content)}</div>`
      )
      .join("");
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `body{font-family:'Segoe UI',Arial,sans-serif;color:#111;margin:32px;font-size:13px;line-height:1.5}` +
      `h1{font-size:20px}.m{margin:14px 0;padding:10px 12px;border:1px solid #ddd;border-radius:8px;page-break-inside:avoid}` +
      `.who{font-weight:600;font-size:11px;color:#666;margin-bottom:6px}` +
      `pre{background:#f5f5f5;padding:8px;border-radius:6px;white-space:pre-wrap}` +
      `.codebar,.code-copy{display:none}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}` +
      `</style></head><body><h1>${esc(c.title)}</h1>${body}</body></html>`;
    const res = await window.aria.app.exportPdf(html, c.title);
    if (typeof res === "string") store().toast("PDF saved to " + res, "ok");
    else if (res && typeof res === "object" && "__error" in res) store().toast("PDF export failed: " + res.__error, "err");
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
        setNewFolderName("");
        setFolderPick(c.id);
      },
    },
    { label: "Export (.md)", icon: "⬇️", onClick: () => exportConv(c) },
    { label: "Export (.pdf)", icon: "🖨", onClick: () => void exportPdf(c) },
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
      {folderPick && (
        <Modal title="Move to folder" onClose={() => setFolderPick(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.values(folders).map((f) => (
              <button
                key={f.id}
                className={"btn" + (conversations[folderPick]?.folderId === f.id ? " primary" : "")}
                onClick={() => {
                  setConvFolder(folderPick, f.id);
                  setFolderPick(null);
                }}
              >
                📁 {f.name}
              </button>
            ))}
            {conversations[folderPick]?.folderId && (
              <button
                className="btn"
                onClick={() => {
                  setConvFolder(folderPick, undefined);
                  setFolderPick(null);
                }}
              >
                ✕ Remove from folder
              </button>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="New folder name…"
                value={newFolderName}
                autoFocus={Object.keys(folders).length === 0}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFolderName.trim()) {
                    const s = store();
                    const folder = { id: uid(), name: newFolderName.trim(), createdAt: Date.now() };
                    useStore.setState({ folders: { ...s.folders, [folder.id]: folder } });
                    setConvFolder(folderPick, folder.id);
                    setFolderPick(null);
                  }
                }}
              />
              <button
                className="btn primary"
                disabled={!newFolderName.trim()}
                onClick={() => {
                  const s = store();
                  const folder = { id: uid(), name: newFolderName.trim(), createdAt: Date.now() };
                  useStore.setState({ folders: { ...s.folders, [folder.id]: folder } });
                  setConvFolder(folderPick, folder.id);
                  setFolderPick(null);
                }}
              >
                Create & move
              </button>
            </div>
          </div>
        </Modal>
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

/** Edit a user message and resend: everything after it is discarded.
 *  Attachments (doc text + images) stored on the message ride along again. */
function editAndResend(convId: string, msgId: string, newText: string) {
  const s = useStore.getState();
  const list = s.messages[convId] ?? [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  const orig = list[idx];
  useStore.setState({ messages: { ...s.messages, [convId]: list.slice(0, idx) } });
  void sendMessage(newText, {
    convId,
    attachmentMeta: orig.attachments,
    attachmentText: orig.attachmentText,
    images: orig.images,
  });
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
          {msg.tokens && (
            <span className="when" title="Real token usage reported by the API (input includes cached tokens)">
              {msg.tokens.in.toLocaleString()}→{msg.tokens.out.toLocaleString()} tok
            </span>
          )}
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
            <button
              className="iconbtn"
              title="Quote in your next message (select text first to quote just that)"
              onClick={() => {
                const sel = window.getSelection()?.toString().trim();
                const src = sel || markdownToText(msg.content).slice(0, 300);
                composerInsert?.("> " + src.replace(/\n+/g, "\n> ") + "\n\n");
              }}
            >
              ❝
            </button>
            <button className="iconbtn" title="Branch: fork a new conversation from this point" onClick={() => branchConversation(convId, msg.id)}>⑂</button>
            {isLast && (
              <button className="iconbtn" title="Regenerate" onClick={() => void regenerateLast(convId)}>↻</button>
            )}
          </div>
        )}
        {isUser && !streaming && !editing && (
          <div className="msg-actions">
            <button className="iconbtn" title="Edit & resend" onClick={() => { setEditText(msg.content); setEditing(true); }}>✏️</button>
            <button className="iconbtn" title="Copy" onClick={copy}>⧉</button>
            <button className="iconbtn" title="Branch: fork a new conversation from this point" onClick={() => branchConversation(convId, msg.id)}>⑂</button>
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

/** "handled" = consumed; "unknown" = looked like a command but isn't one; "not-slash" = send as a normal message. */
async function runSlashCommand(text: string, convId: string | null): Promise<"handled" | "unknown" | "not-slash"> {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return "not-slash";
  const [, cmd, rest] = m;
  const store = useStore.getState();
  if (cmd === "task") {
    if (!rest.trim()) { store.toast("Usage: /task <title>", "err"); return "handled"; }
    addTask({ title: rest.trim() });
    store.toast("Task added", "ok");
    return "handled";
  }
  if (cmd === "remember") {
    if (!rest.trim()) { store.toast("Usage: /remember <fact>", "err"); return "handled"; }
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
    return "handled";
  }
  if (cmd === "artifact") {
    const q = rest.trim().toLowerCase();
    const type = ARTIFACT_TYPES.find((t) => t.id === q || t.name.toLowerCase().includes(q)) ?? ARTIFACT_TYPES[0];
    void generateArtifact(type.id);
    return "handled";
  }
  if (cmd === "research") {
    if (!rest.trim()) { store.toast("Usage: /research <question>", "err"); return "handled"; }
    const research = await maybeRunWebResearch(rest.trim(), true);
    await sendMessage(rest.trim(), {
      convId: convId ?? undefined,
      apiContentOverride: research?.prompt,
      webSources: research?.sources,
    });
    return "handled";
  }
  useStore.getState().toast(`Unknown command /${cmd} — try ${SLASH_COMMANDS.map((c) => c.cmd).join(", ")}`, "err");
  return "unknown";
}

/** Set by the mounted Composer so drag-and-drop anywhere in the chat column attaches files. */
let externalFileDrop: ((files: FileList | File[]) => void) | null = null;
/** Set by the mounted Composer so message actions (quote) can insert text. */
let composerInsert: ((text: string) => void) | null = null;
/** Unsent composer text per conversation — survives switching around. */
const drafts = new Map<string, string>();

function Composer({ convId }: { convId: string | null }) {
  const draftKey = convId ?? "@new";
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
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

  // Load the draft when switching conversations; keep it saved as you type.
  useEffect(() => {
    setText(drafts.get(draftKey) ?? "");
  }, [draftKey]);
  const updateText = (v: string) => {
    setText(v);
    if (v) drafts.set(draftKey, v);
    else drafts.delete(draftKey);
  };

  const doSend = async () => {
    const t = text.trim();
    if (!t || streaming) return;
    const docs = attached.filter((a) => a.kind !== "image");
    const images = attached.filter((a) => a.kind === "image");
    setText("");
    drafts.delete(draftKey);
    setAttached([]);
    setSuggestion(null);
    if (taRef.current) taRef.current.style.height = "auto";

    if (t.startsWith("/")) {
      const r = await runSlashCommand(t, convId);
      if (r === "handled") return;
      if (r === "unknown") {
        // Give the typed text back so a typo ("/tsak …") isn't lost.
        updateText(t);
        return;
      }
    }

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

  const onPickFiles = async (files: FileList | File[] | null) => {
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
    composerInsert = (t) => {
      const cur = taRef.current?.value ?? "";
      updateText(cur ? cur.replace(/\s*$/, "\n\n") + t : t);
      taRef.current?.focus();
      window.setTimeout(autoGrow, 0);
    };
    return () => {
      externalFileDrop = null;
      composerInsert = null;
    };
  }, [draftKey]);

  /** Screenshots / copied images paste straight into the composer as attachments. */
  const onPaste = (e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && /^image\//.test(item.type)) {
        const f = item.getAsFile();
        if (f) files.push(new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.png`, { type: f.type }));
      }
    }
    if (files.length) {
      e.preventDefault();
      void onPickFiles(files);
    }
  };

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
            <div key={c.cmd} className="row" onClick={() => { updateText(c.cmd + " "); taRef.current?.focus(); }}>
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
            updateText(e.target.value);
            autoGrow();
            if (e.target.value.length > 12) setSuggestion(suggestAgent(e.target.value));
            else setSuggestion(null);
          }}
          onPaste={onPaste}
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
  const tasks = useStore((s) => s.tasks);
  const businessProfile = useStore((s) => s.businessProfile);
  const agent = agents.find((a) => a.id === activeAgentId);

  // Starters built from the user's actual data, falling back to generics.
  const starters = useMemo(() => {
    const out: string[] = [];
    const open = tasks.filter((t) => !t.done);
    const overdue = open.find((t) => t.due && t.due < Date.now());
    if (overdue) out.push(`Help me get "${overdue.title.slice(0, 42)}" unstuck`);
    else if (open.length) out.push(`Help me make progress on: ${open[0].title.slice(0, 42)}`);
    const initiative = businessProfile.initiatives
      .split(/[\n,;]/)
      .map((x) => x.trim())
      .filter(Boolean)[0];
    if (initiative) out.push(`What's the next step on: ${initiative.slice(0, 42)}`);
    if (businessProfile.competitors.trim()) out.push("How should we position against our competitors?");
    const stalledGoal = agent?.goals.find((g) => Date.now() - (g.lastActivity ?? g.createdAt) > 7 * 864e5);
    if (stalledGoal) out.push(`Let's restart the stalled goal: ${stalledGoal.text.slice(0, 42)}`);
    for (const g of [
      "Summarise this week's priorities",
      "Draft a follow-up email to a client",
      "Help me plan next quarter",
      "Review a document for risks",
    ]) {
      if (out.length >= 4) break;
      out.push(g);
    }
    return [...new Set(out)].slice(0, 4);
  }, [tasks, businessProfile, agent]);

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

/** Long threads render only the newest chunk; older ones load on demand. */
const RENDER_CHUNK = 60;

export function ChatView() {
  const activeConvId = useStore((s) => s.activeConvId);
  const messages = useStore((s) => (s.activeConvId ? s.messages[s.activeConvId] : undefined));
  const streamingConvId = useStore((s) => s.streamingConvId);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const [find, setFind] = useState<{ open: boolean; q: string; idx: number }>({ open: false, q: "", idx: 0 });
  const findInputRef = useRef<HTMLInputElement>(null);
  const findJumped = useRef(false);

  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    setVisibleCount(RENDER_CHUNK);
    setFind({ open: false, q: "", idx: 0 });
    setShowJump(false);
    stickToBottom.current = true;
  }, [activeConvId]);

  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = fromBottom < 80;
    setShowJump(fromBottom > 300);
  };

  const list = messages ?? [];
  const streaming = !!streamingConvId && streamingConvId === activeConvId;
  const shown = list.slice(-visibleCount);
  const hiddenCount = list.length - shown.length;
  const lastId = list[list.length - 1]?.id;

  const matches = useMemo(() => {
    const q = find.q.trim().toLowerCase();
    if (!q) return [] as string[];
    return list.filter((m) => m.content.toLowerCase().includes(q)).map((m) => m.id);
  }, [find.q, list]);

  const jumpToMatch = (idx: number) => {
    if (!matches.length) return;
    const wrapped = ((idx % matches.length) + matches.length) % matches.length;
    setFind((f) => ({ ...f, idx: wrapped }));
    const id = matches[wrapped];
    const pos = list.findIndex((m) => m.id === id);
    const needed = list.length - pos;
    if (needed > visibleCount) setVisibleCount(needed);
    window.setTimeout(() => {
      const el = threadRef.current?.querySelector(`[data-mid="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.remove("find-flash");
        void (el as HTMLElement).offsetWidth; // restart the flash animation
        el.classList.add("find-flash");
      }
    }, 30);
  };

  // Ctrl+F opens in-thread search (only while the chat view is mounted).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && activeConvId) {
        e.preventDefault();
        setFind((f) => ({ ...f, open: true }));
        window.setTimeout(() => findInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape") setFind((f) => (f.open ? { ...f, open: false } : f));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeConvId]);

  const scrollToBottom = () => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setShowJump(false);
  };

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
        {find.open && activeConvId && (
          <div className="find-bar">
            <input
              ref={findInputRef}
              className="input"
              placeholder="Find in conversation…"
              value={find.q}
              onChange={(e) => {
                findJumped.current = false;
                setFind((f) => ({ ...f, q: e.target.value, idx: 0 }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // First Enter lands on the first match; repeats step through.
                  jumpToMatch(e.shiftKey ? find.idx - 1 : findJumped.current ? find.idx + 1 : find.idx);
                  findJumped.current = true;
                }
                if (e.key === "Escape") setFind((f) => ({ ...f, open: false }));
              }}
            />
            <span className="hint">{matches.length ? `${find.idx + 1} / ${matches.length}` : find.q ? "0 results" : ""}</span>
            <button className="iconbtn" title="Previous" onClick={() => jumpToMatch(find.idx - 1)}>↑</button>
            <button className="iconbtn" title="Next" onClick={() => jumpToMatch(find.idx + 1)}>↓</button>
            <button className="iconbtn" title="Close" onClick={() => setFind((f) => ({ ...f, open: false }))}>✕</button>
          </div>
        )}
        {activeConvId && list.length > 0 ? (
          <div className="thread" ref={threadRef} onScroll={onScroll}>
            <div className="thread-inner">
              {hiddenCount > 0 && (
                <div style={{ textAlign: "center", padding: 8 }}>
                  <button className="btn sm" onClick={() => setVisibleCount((v) => v + RENDER_CHUNK * 2)}>
                    ↑ Show earlier messages ({hiddenCount} more)
                  </button>
                </div>
              )}
              {shown.map((m) => (
                <div key={m.id} data-mid={m.id}>
                  <MessageRow
                    msg={m}
                    convId={activeConvId}
                    isLast={m.id === lastId}
                    streaming={streaming}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState />
        )}
        {showJump && (
          <button className="jump-latest" onClick={scrollToBottom}>↓ Latest</button>
        )}
        <Composer convId={activeConvId} />
      </div>
    </div>
  );
}
