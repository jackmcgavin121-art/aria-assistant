import { useStore } from "../store/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.kind === "ok" ? "✓" : t.kind === "err" ? "⚠" : "ℹ"}</span>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn sm"
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="iconbtn" style={{ width: 22, height: 22 }} onClick={() => dismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
