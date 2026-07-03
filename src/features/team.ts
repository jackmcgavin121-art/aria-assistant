// Team mode: one message → parallel streamed responses from 2+ agents,
// rendered as tabs on a single assistant message.
import { useStore } from "../store/store";
import type { Conversation, Message } from "../types";
import { uid } from "../lib/util";
import { buildSystemPrompt } from "../api/systemPrompt";
import { streamCompletion } from "../api/anthropic";

export async function sendTeamMessage(text: string, agentIds: string[], existingConvId?: string) {
  const store = useStore;
  let s = store.getState();
  if (s.streamingConvId || agentIds.length < 2) return;
  if (!s.hasApiKey) {
    s.toast("Add your Anthropic API key in Settings → AI & API first.", "err");
    return;
  }

  let convId = existingConvId;
  if (!convId || !s.conversations[convId]) {
    const conv: Conversation = {
      id: uid(),
      title: text.slice(0, 44) + (text.length > 44 ? "…" : ""),
      agentId: null,
      teamIds: agentIds,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    convId = conv.id;
    store.setState({
      conversations: { ...s.conversations, [conv.id]: conv },
      messages: { ...s.messages, [conv.id]: [] },
      activeConvId: conv.id,
      view: "chat",
    });
    s = store.getState();
  }

  const userMsg: Message = { id: uid(), role: "user", content: text, ts: Date.now() };
  const teamMsg: Message = {
    id: uid(),
    role: "assistant",
    content: "",
    ts: Date.now(),
    teamResponses: agentIds.map((agentId) => ({ agentId, content: "" })),
  };
  store.setState({
    messages: { ...s.messages, [convId]: [...(s.messages[convId] ?? []), userMsg, teamMsg] },
    streamingConvId: convId,
  });

  const updateEntry = (agentId: string, patch: Partial<{ content: string; error: string }>) => {
    const st = store.getState();
    const list = st.messages[convId!] ?? [];
    store.setState({
      messages: {
        ...st.messages,
        [convId!]: list.map((m) =>
          m.id === teamMsg.id
            ? {
                ...m,
                teamResponses: m.teamResponses!.map((r) =>
                  r.agentId === agentId ? { ...r, ...patch } : r
                ),
              }
            : m
        ),
      },
    });
  };

  await Promise.all(
    agentIds.map(
      (agentId) =>
        new Promise<void>((resolve) => {
          const st = store.getState();
          const agent = st.agents.find((a) => a.id === agentId) ?? null;
          const { system } = buildSystemPrompt(st, agent, st.conversations[convId!], text);
          streamCompletion(
            {
              model: agent?.model || st.model,
              maxTokens: st.maxTokens,
              system:
                system +
                "\n\nYou are one specialist on a team all answering the same request. Answer from YOUR discipline's perspective; be direct and specific.",
              messages: [{ role: "user", content: text }],
            },
            {
              onText: (_d, full) => updateEntry(agentId, { content: full }),
              onDone: () => resolve(),
              onAborted: () => resolve(),
              onError: (message) => {
                updateEntry(agentId, { error: message });
                resolve();
              },
            }
          );
        })
    )
  );

  store.setState({ streamingConvId: null });
}
