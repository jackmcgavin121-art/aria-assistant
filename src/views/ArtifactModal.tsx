import { useState } from "react";
import { useStore } from "../store/store";
import type { Artifact } from "../types";
import { Modal } from "../components/Modal";
import { ARTIFACT_TYPES, generateArtifact, exportArtifact, exportSlides } from "../features/artifacts";
import { renderMarkdown, markdownToText } from "../lib/markdown";
import { fmtDateTime } from "../lib/util";

export function ArtifactModal({ onClose }: { onClose: () => void }) {
  const artifacts = useStore((s) => s.artifacts);
  const activeConvId = useStore((s) => s.activeConvId);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Artifact | null>(null);

  const list = Object.values(artifacts).sort((a, b) => b.createdAt - a.createdAt);

  if (viewing) {
    return (
      <Modal
        title={viewing.title}
        onClose={() => setViewing(null)}
        wide
        footer={
          <>
            <button className="btn" onClick={() => exportArtifact(viewing, "md")}>.md</button>
            <button className="btn" onClick={() => exportArtifact(viewing, "txt")}>.txt</button>
            <button className="btn" onClick={() => exportArtifact(viewing, "html")}>.html</button>
            <button className="btn" onClick={() => exportArtifact(viewing, "doc")}>Word (.doc)</button>
            <button
              className="btn"
              title="Open in your default email app"
              onClick={() => {
                const body = markdownToText(viewing.content).slice(0, 1800);
                void window.aria.app.openExternal(`mailto:?subject=${encodeURIComponent(viewing.title)}&body=${encodeURIComponent(body)}`);
              }}
            >
              ✉️ Email
            </button>
            {viewing.type === "deck" && <button className="btn primary" onClick={() => exportSlides(viewing)}>🖥 Slides (.html)</button>}
          </>
        }
      >
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(viewing.content) }} />
      </Modal>
    );
  }

  return (
    <Modal title="Documents & artifacts" onClose={onClose} wide>
      <label className="label">Generate from the current conversation</label>
      {!activeConvId && <p className="hint">Open a conversation first — artifacts are built from its content.</p>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {ARTIFACT_TYPES.map((t) => (
          <button
            key={t.id}
            className="chip"
            disabled={!activeConvId || !!busy}
            onClick={async () => {
              setBusy(t.id);
              const a = await generateArtifact(t.id);
              setBusy(null);
              if (a) setViewing(a);
            }}
          >
            {busy === t.id ? "⏳" : t.icon} {t.name}
          </button>
        ))}
      </div>
      <label className="label">Saved documents ({list.length})</label>
      {list.length === 0 && <p className="hint">Generated documents are saved here and in their project's Docs tab.</p>}
      {list.map((a) => (
        <div key={a.id} className="list-row">
          <span>{ARTIFACT_TYPES.find((t) => t.id === a.type)?.icon ?? "📄"}</span>
          <div className="lr-title">
            <div className="t">{a.title}</div>
            <div className="s">{fmtDateTime(a.createdAt)}</div>
          </div>
          <button className="btn sm" onClick={() => setViewing(a)}>Open</button>
          <button className="iconbtn" onClick={() => {
            const s = useStore.getState();
            const next = { ...s.artifacts };
            delete next[a.id];
            useStore.setState({ artifacts: next });
          }}>🗑</button>
        </div>
      ))}
    </Modal>
  );
}
