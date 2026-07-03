import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import type { Message } from "../types";
import { uid } from "../lib/util";
import { buildSystemPrompt } from "../api/systemPrompt";
import { streamCompletion } from "../api/anthropic";
import { renderMarkdown } from "../lib/markdown";

/**
 * Customer portal: a minimal, scoped chat with one published agent.
 * Messages here are kept in local component state only — portal visitors
 * never see (or write to) the rest of the app's data.
 */
export function PortalView({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const model = useStore((s) => s.model);
  const maxTokens = useStore((s) => s.maxTokens);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  if (!agent || !agent.published) {
    return (
      <div className="empty-state">
        <div className="big">🔒</div>
        <h2>This portal isn't available</h2>
        <button className="btn" onClick={() => useStore.setState({ portalAgentId: null })}>Back to ARIA</button>
      </div>
    );
  }

  const send = () => {
    const t = text.trim();
    if (!t || streaming || !hasApiKey) return;
    setText("");
    const userMsg: Message = { id: uid(), role: "user", content: t, ts: Date.now() };
    const aiMsg: Message = { id: uid(), role: "assistant", content: "", ts: Date.now(), agentId };
    const history = [...msgs, userMsg];
    setMsgs([...history, aiMsg]);
    setStreaming(true);

    // Portal prompts include ONLY the agent's own instructions/knowledge — no
    // company records, no other agents' data, no user profile.
    const s = useStore.getState();
    const scoped = { ...s, fileKnowledge: s.fileKnowledge.filter((d) => d.agentIds.includes(agentId)), businessProfile: { ...s.businessProfile }, companyMemory: { customers: [], products: [], equipment: [], processes: [], notes: [], learningLog: [] }, workspace: null, profile: { name: "", jobRole: "", company: s.profile.company, industry: s.profile.industry } } as typeof s;
    const { system } = buildSystemPrompt(scoped, agent, null);

    streamCompletion(
      {
        model,
        maxTokens,
        system: system + "\n\nYou are answering a customer through a public portal. Be helpful and professional; do not reveal internal information.",
        messages: history.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content })),
      },
      {
        onText: (_d, full) => setMsgs((cur) => cur.map((m) => (m.id === aiMsg.id ? { ...m, content: full } : m))),
        onDone: () => setStreaming(false),
        onAborted: () => setStreaming(false),
        onError: (e) => {
          setMsgs((cur) => cur.map((m) => (m.id === aiMsg.id ? { ...m, content: "Sorry — something went wrong. Please try again." } : m)));
          console.warn(e);
          setStreaming(false);
        },
      }
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", maxWidth: 720, margin: "0 auto", width: "100%" }}>
      <div className="topbar" style={{ justifyContent: "space-between" }}>
        <h1>{agent.emoji} {agent.name}</h1>
        <button className="btn sm ghost" onClick={() => useStore.setState({ portalAgentId: null })}>Exit portal preview</button>
      </div>
      <div className="thread" ref={scrollRef}>
        <div className="thread-inner">
          {msgs.length === 0 && (
            <div className="empty-state">
              <div className="big">{agent.emoji}</div>
              <h2>Chat with {agent.name}</h2>
              <p>{agent.role}</p>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={"msg" + (m.role === "user" ? " user" : "")}>
              <div className="avatar">{m.role === "user" ? "You"[0] : agent.emoji}</div>
              <div className="bubble">
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content || "…") }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            rows={1}
            placeholder={`Ask ${agent.name}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-bar">
            <span className="grow" />
            <button className="btn primary sm" disabled={!text.trim() || streaming} onClick={send}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}
