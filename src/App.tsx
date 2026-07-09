import { useEffect, useState } from "react";
import { useStore } from "./store/store";
import type { ViewId } from "./types";
import { ChatView, AgentPicker } from "./views/ChatView";
import { DashboardView } from "./views/DashboardView";
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
import { LoginScreen } from "./views/LoginScreen";
import { Toasts } from "./components/Toasts";
import { Modal } from "./components/Modal";
import { logout } from "./lib/auth";
import { entitlementOk, refreshEntitlement } from "./lib/cloud";
import { initRecurringScheduler } from "./features/tasks";
import { initProactiveChecks } from "./features/autonomy";
import { activeTaskCount } from "./features/agentExec";

const NAV: { id: ViewId; icon: string; label: string; key: string }[] = [
  { id: "home", icon: "🏠", label: "Home", key: "1" },
  { id: "chat", icon: "💬", label: "Chat", key: "2" },
  { id: "agents", icon: "🤖", label: "Agents", key: "3" },
  { id: "knowledge", icon: "📚", label: "Knowledge", key: "4" },
  { id: "projects", icon: "📁", label: "Projects", key: "5" },
  { id: "tasks", icon: "☑️", label: "Tasks", key: "6" },
  { id: "agenthub", icon: "🎯", label: "Agent Hub", key: "7" },
  { id: "workload", icon: "📊", label: "Workload", key: "8" },
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
  const currentUser = useStore((s) => s.currentUser);
  const authEnabled = useStore((s) => s.settings.authEnabled);
  const label = view === "chat" ? conv?.title ?? "Chat" : NAV.find((n) => n.id === view)?.label ?? "";
  return (
    <div className="topbar">
      <h1>{label}</h1>
      {view === "chat" && <AgentPicker />}
      {view === "chat" && activeConvId && <button className="btn sm" onClick={onOpenArtifacts}>📄 Artifacts</button>}
      <button className="btn sm" onClick={onOpenVoice}>🎤 Voice</button>
      {authEnabled && currentUser && (
        <button
          className="btn sm"
          title={`Signed in as ${currentUser.email} (${currentUser.role})`}
          onClick={logout}
        >
          👤 {currentUser.name || currentUser.email.split("@")[0]} · Sign out
        </button>
      )}
      <button className="iconbtn" title="Toggle theme" onClick={() => useStore.setState({ darkMode: !darkMode })}>
        {darkMode ? "☀️" : "🌙"}
      </button>
    </div>
  );
}

function BootScreen() {
  const bootStatus = useStore((s) => s.bootStatus);
  const bootError = useStore((s) => s.bootError);
  const [recovering, setRecovering] = useState(false);
  const [recoverMsg, setRecoverMsg] = useState("");

  const restoreLatest = async () => {
    if (!window.aria.store.restoreLatestBackup) return;
    setRecovering(true);
    const r = await window.aria.store.restoreLatestBackup();
    if (r.ok) window.location.reload();
    else {
      setRecovering(false);
      setRecoverMsg(r.error);
    }
  };
  const restoreFromFile = async () => {
    if (!window.aria.store.replaceFromFile) return;
    setRecovering(true);
    const r = await window.aria.store.replaceFromFile();
    if (r.ok) window.location.reload();
    else {
      setRecovering(false);
      if (r.error !== "cancelled") setRecoverMsg(r.error);
    }
  };

  if (bootStatus === "storage_error") {
    return (
      <div className="empty-state">
        <div className="big">⚠️</div>
        <h2>Couldn't read your saved data</h2>
        <p className="hint" style={{ maxWidth: 440 }}>
          The data file exists but couldn't be loaded, so ARIA stopped rather than overwrite it.
          Error: {bootError}
        </p>
        <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
          {window.aria.store.restoreLatestBackup && (
            <button className="btn primary" disabled={recovering} onClick={() => void restoreLatest()}>
              {recovering ? "Restoring…" : "↩ Restore latest automatic backup"}
            </button>
          )}
          {window.aria.store.replaceFromFile && (
            <button className="btn" disabled={recovering} onClick={() => void restoreFromFile()}>
              📂 Restore from a backup file…
            </button>
          )}
        </div>
        {recoverMsg && <p className="hint" style={{ maxWidth: 440 }}>{recoverMsg}</p>}
        <p className="hint" style={{ maxWidth: 440 }}>
          Restoring keeps a copy of the current (broken) file next to it, so nothing is lost either way.
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const fontScale = useStore((s) => s.settings.fontScale);
  const closeToTray = useStore((s) => s.settings.closeToTray);
  const unreadAlerts = useStore((s) => s.proactiveAlerts.filter((a) => !a.read).length);
  const authEnabled = useStore((s) => s.settings.authEnabled);
  const currentUser = useStore((s) => s.currentUser);
  const firstRun = useStore(
    (s) => !s.settings.authEnabled && !s.settings.onboarded && !s.settings.authSetupDismissed && s.accounts.length === 0
  );
  // Subscribed so a refreshed entitlement (new object) re-renders the gate.
  useStore((s) => s.settings.cloudEntitlement);

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
    // "What's new" note the first time a new version runs.
    void window.aria.app.info().then((info) => {
      const s = useStore.getState();
      const last = s.settings.lastSeenVersion;
      if (last && last !== info.version) {
        s.toast(`ARIA updated to v${info.version}`, "ok", {
          label: "What's new",
          onClick: () =>
            void window.aria.app.openExternal("https://github.com/jackmcgavin121-art/aria-assistant/releases"),
        });
      }
      if (last !== info.version) {
        useStore.setState({ settings: { ...s.settings, lastSeenVersion: info.version } });
      }
    });
  }, [bootStatus]);

  // Cloud workspace: refresh the cached entitlement after boot and twice a
  // day. Failures keep the cache (14-day offline grace).
  useEffect(() => {
    if (bootStatus !== "ready") return;
    void refreshEntitlement();
    const t = window.setInterval(() => void refreshEntitlement(), 12 * 3600_000);
    return () => window.clearInterval(t);
  }, [bootStatus]);

  // Idle auto sign-out (Settings → Team access). Any input resets the clock.
  const idleLogoutMinutes = useStore((s) => s.settings.idleLogoutMinutes ?? 0);
  useEffect(() => {
    if (!authEnabled || !currentUser || !idleLogoutMinutes) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last >= idleLogoutMinutes * 60_000) {
        logout();
        useStore.getState().toast("Signed out after inactivity.", "info");
      }
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      for (const ev of events) window.removeEventListener(ev, bump);
    };
  }, [authEnabled, currentUser, idleLogoutMinutes]);

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
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
      const tag = (e.target as HTMLElement).tagName;
      if ((e.ctrlKey || e.metaKey) && /^[1-8]$/.test(e.key) && tag !== "INPUT" && tag !== "TEXTAREA") {
        const nav = NAV[+e.key - 1];
        if (nav) useStore.setState({ view: nav.id });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (bootStatus !== "ready") return <BootScreen />;

  // Login gate: when Team access is on, nothing loads until someone signs in.
  // Fresh installs also land here (admin/staff chooser) until they set up a
  // workspace, join one, or skip ("just me on this PC").
  if ((authEnabled || firstRun) && !currentUser) {
    return (
      <>
        <LoginScreen />
        <Toasts />
      </>
    );
  }

  // Cloud workspace out of standing (subscription ended / 14 days unverified):
  // block with an honest explanation rather than silently degrading.
  {
    const ent = entitlementOk();
    if (!ent.ok) return <EntitlementScreen reason={ent.reason!} />;
  }

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
          {view === "home" && <DashboardView />}
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
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      <Toasts />
    </div>
  );
}

function EntitlementScreen({ reason }: { reason: string }) {
  const [checking, setChecking] = useState(false);
  const retry = async () => {
    setChecking(true);
    await refreshEntitlement();
    setChecking(false);
  };
  return (
    <div className="empty-state">
      <div className="big">🔒</div>
      <h2>Workspace check needed</h2>
      <p className="hint" style={{ maxWidth: 440 }}>{reason}</p>
      <p className="hint" style={{ maxWidth: 440 }}>
        Your data is safe on this PC — this only pauses the app until the workspace is verified.
      </p>
      <div className="row" style={{ justifyContent: "center" }}>
        <button className="btn primary" disabled={checking} onClick={() => void retry()}>
          {checking ? "Checking…" : "🔄 Check again"}
        </button>
        <button className="btn" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "Ctrl K", what: "Command palette & global search" },
  { keys: "Ctrl P", what: "Quick-switch between recent conversations" },
  { keys: "Ctrl F", what: "Find in the open conversation" },
  { keys: "Ctrl B", what: "Collapse / expand the sidebar" },
  { keys: "Ctrl 1–8", what: "Jump to a view (Home, Chat, Agents…)" },
  { keys: "Ctrl /", what: "This cheat sheet" },
  { keys: "Enter", what: "Send message" },
  { keys: "Shift Enter", what: "New line in the composer" },
  { keys: "Esc", what: "Close panels and dialogs" },
];

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      {SHORTCUTS.map((s) => (
        <div key={s.keys} className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
          <span>{s.what}</span>
          <span className="kbd">{s.keys}</span>
        </div>
      ))}
      <div className="hint" style={{ marginTop: 8 }}>
        Tip: type <b>/</b> at the start of a message for slash commands (/task, /remember, /research, /artifact).
      </div>
    </Modal>
  );
}
