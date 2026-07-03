import { useStore } from "../store/store";
import { Modal } from "../components/Modal";
import { approveProposal, markAlertRead, dismissAlert } from "../features/autonomy";
import { openConversation } from "../features/chat";
import { fmtDateTime } from "../lib/util";

const TYPE_ICON: Record<string, string> = {
  goal_critical: "🚨",
  goal_stalled: "🐢",
  task_overdue: "⏰",
  task_completed: "✅",
  approval_needed: "🙋",
  info: "ℹ️",
};

export function AlertsPanel() {
  const alerts = useStore((s) => s.proactiveAlerts);
  const agents = useStore((s) => s.agents);
  const close = () => useStore.setState({ alertsOpen: false });

  return (
    <Modal
      title={`Alerts (${alerts.filter((a) => !a.read).length} unread)`}
      onClose={close}
      wide
      headExtra={
        alerts.length > 0 ? (
          <button className="btn sm" onClick={() => useStore.setState({ proactiveAlerts: alerts.map((a) => ({ ...a, read: true })) })}>
            Mark all read
          </button>
        ) : undefined
      }
    >
      {alerts.length === 0 && (
        <p className="hint">
          No alerts. Agents raise alerts here when they complete assigned work, when a proactive check finds a stalled
          goal or overdue task, or when an autonomous agent wants approval before acting.
        </p>
      )}
      {alerts.map((al) => {
        const agent = agents.find((a) => a.id === al.agentId);
        return (
          <div key={al.id} className="list-row" style={{ opacity: al.read ? 0.65 : 1 }}>
            <span style={{ fontSize: 18 }}>{TYPE_ICON[al.type] ?? "ℹ️"}</span>
            <div className="lr-title">
              <div className="t">{agent ? `${agent.emoji} ` : ""}{al.title}</div>
              <div className="s">{al.body}</div>
              <div className="s">{fmtDateTime(al.ts)}</div>
            </div>
            {al.type === "approval_needed" && al.proposedAction && (
              <button className="btn sm primary" onClick={() => approveProposal(al.id)}>Approve & run</button>
            )}
            {al.convId && (
              <button className="btn sm" onClick={() => { markAlertRead(al.id); openConversation(al.convId!); close(); }}>Open</button>
            )}
            {!al.read && <button className="btn sm ghost" onClick={() => markAlertRead(al.id)}>Read</button>}
            <button className="iconbtn" onClick={() => dismissAlert(al.id)}>🗑</button>
          </div>
        );
      })}
    </Modal>
  );
}
