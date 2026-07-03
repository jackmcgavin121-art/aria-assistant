import { useEffect, useState } from "react";
import { useStore } from "./store/store";
import type { ViewId } from "./types";
import { ChatView, AgentPicker } from "./views/ChatView";
import { AgentsView } from "./views/AgentsView";
import { KnowledgeView } from "./views/KnowledgeView";
import { ProjectsView } from "./views/ProjectsView";
import { TasksView } from "./views/TasksView";
import { AgentHubView } from "./views/AgentHubView";
import { WorkloadView } from "./views/WorkloadView";
import { SettingsModal } from "./views/SettingsModal";
import { Onboarding } from "./views/Onboarding";
import { AlertsPanel } from "./views/AlertsPanel";
import { GlobalSearch } from "./views/GlobalSearch";
import { ArtifactModal } from "./views/ArtifactModal";
import { VoiceModal } from "./views/VoiceModal";
import { PortalView } from "./views/PortalView";
import { Toasts } from "./components/Toasts";
import { initRecurringScheduler } from "./features/tasks";
import { initProactiveChecks } from "./features/autonomy";
import { activeTaskCount } from "./features/agentExec";

const NAV: { id: ViewId; icon: string; label: string; key: string }[] = [
  { id: "chat", icon: "💬", label: "Chat", key: "1" },
  { id: "agents", icon: "🤖", label: "Agents", key: "2" },
  { id: "knowledge", icon: "📚", label: "Knowledge", key: "3" },
  { id: "projects", icon: "📁", label: "Projects", key: "4" },
  { id: "tasks", icon: "☑️", label: "Tasks", key: "5" },
  { id: "agenthub", icon: "🎯", label: "Agent Hub", key: "6" },
  { id: "workload", icon: "📊", label: "Workload", key: "7" },
];

function Sidebar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const alerts = useStore((s) => s.proactiveAlerts);
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const collapsed = useStore((s) => s.settings.sidebarCollapsed);
  const unread = alerts.filter((a) => !a.read).length;
  const openTasks = tasks.filter((t) => !t.done).length;
  const activeAgentTasks = agents.reduce((n, a) => n + activeTaskCount(a), 0);
  const publishedAgents = agents.filter((a) => a.published);

  return (
    <div className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <div className="sb-logo"><span className="dot" /> ARIA</div>
      {NAV.map((n) => (
        <button key={n.id} className={"nav-item" + (view === n.id ? " on" : "")} onClick={() => setView(n.id)} title={collapsed ? n.label : undefined}>
          <span>{n.icon}</span>
          <span>{n.label}</span>
          {n.id === "tasks" && openTasks > 0 && <span className="nav-badge">{openTasks}</span>}
          {n.id === "workload" && activeAgentTasks > 0 && <span className="nav-badge">{activeAgentTasks}</span>}
        </button>
      ))}
      <div className="sb-footer">
        {publishedAgents.length > 0 && (
          <button className="nav-item" onClick={() => useStore.setState({ portalAgentId: publishedAgents[0].id })}>
            <span>🔗</span><span>Portal preview</span>
          </button>
        )}
        <button className="nav-item" onClick={() => useStore.setState({ alertsOpen: true })}>
          <span>🔔</span><span>Alerts</span>
          {unread > 0 && <span className="nav-badge warn">{unread}</span>}
        </button>
        <button className="nav-item" onClick={() => useStore.setState({ searchOpen: true })}>
          <span>🔍</span><span>Search</span><span className="kbd" style={{ marginLeft: "auto" }}>Ctrl K</span>
        </button>
        <button className="nav-item" onClick={() => useStore.setState({ settingsOpen: true })} title={collapsed ? "Settings" : undefined}>
          <span>⚙️</span><span>Settings</span>
        </button>
        <button
          className="nav-item"
          title={(collapsed ? "Expand" : "Collapse") + " sidebar (Ctrl+B)"}
          onClick={() => {
            const s = useStore.getState();
            useStore.setState({ settings: { ...s.settings, sidebarCollapsed: !collapsed } });
          }}
        >
          <span>{collapsed ? "»" : "«"}</span><span>Collapse</span>
        </button>
      </div>
    </div>
  );
}

function TopBar({ onOpenArtifacts, onOpenVoice }: { onOpenArtifacts: () => void; onOpenVoice: () => void }) {
  const view = useStore((s) => s.view);
  const activeConvId = useStore((s) => s.activeConvId);
  const conv = useStore((s) => (s.activeConvId ? s.conversations[s.activeConvId] : undefined));
  const darkMode = useStore((s) => s.darkMode);
  const label = view === "chat" ? conv?.title ?? "Chat" : NAV.find((n) => n.id === view)?.label ?? "";
  return (
    <div className="topbar">
      <h1>{label}</h1>
      {view === "chat" && <AgentPicker />}
      {view === "chat" && activeConvId && <button className="btn sm" onClick={onOpenArtifacts}>📄 Artifacts</button>}
      <button className="btn sm" onClick={onOpenVoice}>🎤 Voice</button>
      <button className="iconbtn" title="Toggle theme" onClick={() => useStore.setState({ darkMode: !darkMode })}>
        {darkMode ? "☀️" : "🌙"}
      </button>
    </div>
  );
}

function BootScreen() {
  const bootStatus = useStore((s) => s.bootStatus);
  const bootError = useStore((s) => s.bootError);
  if (bootStatus === "storage_error") {
    return (
      <div className="empty-state">
        <div className="big">⚠️</div>
        <h2>Couldn't read your saved data</h2>
        <p className="hint" style={{ maxWidth: 420 }}>
          The data file exists but couldn't be loaded, so ARIA stopped rather than overwrite it.
          Error: {bootError}
        </p>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <div className="big">✦</div>
      <h2>Starting ARIA…</h2>
    </div>
  );
}

export default function App() {
  const bootStatus = useStore((s) => s.bootStatus);
  const view = useStore((s) => s.view);
  const darkMode = useStore((s) => s.darkMode);
  const compactMode = useStore((s) => s.compactMode);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const onboardingOpen = useStore((s) => s.onboardingOpen);
  const alertsOpen = useStore((s) => s.alertsOpen);
  const searchOpen = useStore((s) => s.searchOpen);
  const portalAgentId = useStore((s) => s.portalAgentId);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const fontScale = useStore((s) => s.settings.fontScale);
  const closeToTray = useStore((s) => s.settings.closeToTray);
  const unreadAlerts = useStore((s) => s.proactiveAlerts.filter((a) => !a.read).length);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    (document.body.style as any).zoom = String(fontScale);
  }, [fontScale]);

  useEffect(() => {
    void window.aria.app.setCloseToTray?.(closeToTray);
  }, [closeToTray]);

  useEffect(() => {
    void window.aria.app.setTrayTooltip?.(unreadAlerts ? `ARIA — ${unreadAlerts} unread alert${unreadAlerts === 1 ? "" : "s"}` : "ARIA");
  }, [unreadAlerts]);

  useEffect(() => {
    window.aria.updates?.onEvent(({ type, info }) => {
      const t = useStore.getState().toast;
      if (type === "available") t(`Update ${info.version} found — downloading in the background…`, "info");
      if (type === "downloaded")
        t(`ARIA ${info.version} is ready to install.`, "ok", {
          label: "Restart now",
          onClick: () => void window.aria.updates?.install(),
        });
    });
  }, []);

  useEffect(() => {
    if (bootStatus !== "ready") return;
    initRecurringScheduler();
    initProactiveChecks();
  }, [bootStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.setState({ searchOpen: !useStore.getState().searchOpen, searchMode: "all" });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        useStore.setState({ searchOpen: !useStore.getState().searchOpen, searchMode: "convs" });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        const s = useStore.getState();
        useStore.setState({ settings: { ...s.settings, sidebarCollapsed: !s.settings.sidebarCollapsed } });
      }
      const tag = (e.target as HTMLElement).tagName;
      if ((e.ctrlKey || e.metaKey) && /^[1-7]$/.test(e.key) && tag !== "INPUT" && tag !== "TEXTAREA") {
        const nav = NAV[+e.key - 1];
        if (nav) useStore.setState({ view: nav.id });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (bootStatus !== "ready") return <BootScreen />;

  if (portalAgentId) {
    return (
      <div className={compactMode ? "compact" : ""} style={{ height: "100%" }}>
        <PortalView agentId={portalAgentId} />
        <Toasts />
      </div>
    );
  }

  return (
    <div className={"shell" + (compactMode ? " compact" : "")}>
      <Sidebar />
      <div className="main">
        <TopBar onOpenArtifacts={() => setArtifactsOpen(true)} onOpenVoice={() => setVoiceOpen(true)} />
        <div className="content">
          {view === "chat" && <ChatView />}
          {view === "agents" && <AgentsView />}
          {view === "knowledge" && <KnowledgeView />}
          {view === "projects" && <ProjectsView />}
          {view === "tasks" && <TasksView />}
          {view === "agenthub" && <AgentHubView />}
          {view === "workload" && <WorkloadView />}
        </div>
      </div>
      {settingsOpen && <SettingsModal onClose={() => useStore.setState({ settingsOpen: false })} />}
      {onboardingOpen && <Onboarding />}
      {alertsOpen && <AlertsPanel />}
      {searchOpen && <GlobalSearch />}
      {artifactsOpen && <ArtifactModal onClose={() => setArtifactsOpen(false)} />}
      {voiceOpen && <VoiceModal onClose={() => setVoiceOpen(false)} />}
      <Toasts />
    </div>
  );
}
