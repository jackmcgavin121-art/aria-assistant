import { useEffect, useState } from "react";
import { useStore, applyImport, flushSave, serializeState } from "../store/store";
import { MODELS } from "../data/presets";
import { Modal, ConfirmModal } from "../components/Modal";
import { hashPw, fmtDate } from "../lib/util";
import { listVoices, speak, ttsSupported } from "../lib/tts";
import { restoreConversation, purgeConversation } from "../features/chat";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "ai", label: "AI & API" },
  { id: "usage", label: "Usage" },
  { id: "voice", label: "Voice" },
  { id: "workspace", label: "Workspace" },
  { id: "web", label: "Web research" },
  { id: "admin", label: "Admin" },
  { id: "data", label: "Data" },
];

/** Published per-MTok USD rates for cost estimates (cache read = 10% of input, write = 125%). */
const PRICES: { match: RegExp; in: number; out: number }[] = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 1, out: 5 },
];

function estimateCost(model: string, b: { in: number; out: number; cacheRead: number; cacheWrite: number }): number | null {
  const p = PRICES.find((x) => x.match.test(model));
  if (!p) return null;
  return (
    (b.in * p.in + b.out * p.out + b.cacheRead * p.in * 0.1 + b.cacheWrite * p.in * 1.25) / 1e6
  );
}

function UsageTab() {
  const usage = useStore((s) => s.usage);
  const months = Object.keys(usage).sort().reverse();
  if (!months.length) {
    return <p className="hint">No API usage recorded yet. Token counts come straight from the API's own responses and start accumulating with your next message.</p>;
  }
  return (
    <div style={{ maxWidth: 640 }}>
      <p className="hint">
        Real token counts reported by the Anthropic API — nothing is estimated except the cost column,
        which uses published list prices (cached input billed at 10%, cache writes at 125%).
      </p>
      {months.map((month) => {
        const byModel = usage[month];
        let monthCost = 0;
        let costKnown = true;
        const rows = Object.entries(byModel).map(([model, b]) => {
          const cost = estimateCost(model, b);
          if (cost === null) costKnown = false;
          else monthCost += cost;
          return { model, b, cost };
        });
        return (
          <div key={month} className="card" style={{ marginBottom: 12 }}>
            <h3>
              {month}
              {rows.length > 0 && (
                <span className="tag" style={{ marginLeft: 8 }}>
                  {costKnown ? `≈ $${monthCost.toFixed(2)}` : "cost unknown for some models"}
                </span>
              )}
            </h3>
            <table className="usage-table">
              <thead>
                <tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Est. cost</th></tr>
              </thead>
              <tbody>
                {rows.map(({ model, b, cost }) => (
                  <tr key={model}>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{model.replace(/^claude-/, "")}</td>
                    <td>{b.calls.toLocaleString()}</td>
                    <td>{b.in.toLocaleString()}</td>
                    <td>{b.out.toLocaleString()}</td>
                    <td>{b.cacheRead.toLocaleString()}</td>
                    <td>{b.cacheWrite.toLocaleString()}</td>
                    <td>{cost === null ? "—" : `$${cost.toFixed(2)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function TrashSection() {
  const conversations = useStore((s) => s.conversations);
  const trashed = Object.values(conversations)
    .filter((c) => c.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  if (!trashed.length) return <p className="hint">Trash is empty. Deleted conversations sit here for 30 days before being removed.</p>;
  return (
    <div>
      <p className="hint">Deleted conversations are kept for 30 days, then removed permanently.</p>
      {trashed.map((c) => (
        <div key={c.id} className="row" style={{ padding: "4px 0", gap: 8 }}>
          <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.title} <span className="hint">({fmtDate(c.deletedAt)})</span>
          </span>
          <button className="btn sm" onClick={() => restoreConversation(c.id)}>↩ Restore</button>
          <button className="btn sm danger" onClick={() => purgeConversation(c.id)}>Delete forever</button>
        </div>
      ))}
      <button
        className="btn sm danger"
        style={{ marginTop: 8 }}
        onClick={() => {
          for (const c of trashed) purgeConversation(c.id);
        }}
      >
        🗑 Empty trash ({trashed.length})
      </button>
    </div>
  );
}

function SecretField({ name, label, hint }: { name: string; label: string; hint?: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const toast = useStore((s) => s.toast);

  const refresh = () => void window.aria.secrets.preview(name).then(setPreview);
  useEffect(refresh, [name]);

  const save = async () => {
    await window.aria.secrets.set(name, value.trim());
    if (name === "anthropicApiKey") useStore.setState({ hasApiKey: !!value.trim() });
    setValue("");
    setEditing(false);
    refresh();
    toast(value.trim() ? `${label} saved (encrypted with Windows DPAPI)` : `${label} removed`, "ok");
  };

  return (
    <div>
      <label className="label">{label}</label>
      {!editing ? (
        <div className="row">
          <span className="hint grow" style={{ fontFamily: "var(--mono)" }}>{preview ?? "not set"}</span>
          <button className="btn sm" onClick={() => setEditing(true)}>{preview ? "Replace" : "Add key"}</button>
          {preview && (
            <button className="btn sm danger" onClick={async () => {
              await window.aria.secrets.set(name, "");
              if (name === "anthropicApiKey") useStore.setState({ hasApiKey: false });
              refresh();
            }}>Remove</button>
          )}
        </div>
      ) : (
        <div className="row">
          <input className="input grow" type="password" autoFocus placeholder="Paste key…" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
          <button className="btn sm primary" onClick={() => void save()}>Save</button>
          <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
      {hint && <p className="hint" style={{ marginTop: 4 }}>{hint}</p>}
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const tab = s.settingsTab;
  const setTab = (t: string) => useStore.setState({ settingsTab: t });
  const toast = s.toast;
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [adminPw, setAdminPw] = useState("");
  const [voices, setVoices] = useState(listVoices());

  useEffect(() => {
    if (!ttsSupported()) return;
    const update = () => setVoices(listVoices());
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);

  const patchSettings = (patch: Partial<typeof s.settings>) =>
    useStore.setState({ settings: { ...useStore.getState().settings, ...patch } });
  const patchProfile = (patch: Partial<typeof s.profile>) =>
    useStore.setState({ profile: { ...useStore.getState().profile, ...patch } });
  const patchRules = (patch: Partial<typeof s.settings.adminRules>) =>
    patchSettings({ adminRules: { ...useStore.getState().settings.adminRules, ...patch } });

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={"tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "profile" && (
        <div style={{ maxWidth: 480 }}>
          <label className="label">Your name</label>
          <input className="input" value={s.profile.name} onChange={(e) => patchProfile({ name: e.target.value })} />
          <label className="label">Job role</label>
          <input className="input" value={s.profile.jobRole} onChange={(e) => patchProfile({ jobRole: e.target.value })} />
          <label className="label">Company</label>
          <input className="input" value={s.profile.company} onChange={(e) => patchProfile({ company: e.target.value })} />
          <label className="label">Industry</label>
          <input className="input" value={s.profile.industry} onChange={(e) => patchProfile({ industry: e.target.value })} />
          <hr className="divider" />
          <label className="checkbox-row"><input type="checkbox" checked={s.darkMode} onChange={(e) => useStore.setState({ darkMode: e.target.checked })} /> Dark mode</label>
          <label className="checkbox-row"><input type="checkbox" checked={s.showTimestamps} onChange={(e) => useStore.setState({ showTimestamps: e.target.checked })} /> Show message timestamps</label>
          <label className="checkbox-row"><input type="checkbox" checked={s.compactMode} onChange={(e) => useStore.setState({ compactMode: e.target.checked })} /> Compact messages</label>
          <label className="label">Interface size: {Math.round(s.settings.fontScale * 100)}%</label>
          <input type="range" min={0.85} max={1.3} step={0.05} value={s.settings.fontScale} onChange={(e) => patchSettings({ fontScale: +e.target.value })} style={{ width: "100%", accentColor: "var(--ac)" }} />
          <hr className="divider" />
          <label className="checkbox-row" title="Windows toast when an agent finishes work or raises an alert while ARIA is in the background">
            <input type="checkbox" checked={s.settings.notificationsEnabled} onChange={(e) => patchSettings({ notificationsEnabled: e.target.checked })} /> Desktop notifications for alerts
          </label>
          <label className="checkbox-row" title="Closing the window hides ARIA to the system tray instead of quitting">
            <input type="checkbox" checked={s.settings.closeToTray} onChange={(e) => patchSettings({ closeToTray: e.target.checked })} /> Close to system tray (keep agents working)
          </label>
        </div>
      )}

      {tab === "ai" && (
        <div style={{ maxWidth: 540 }}>
          <SecretField
            name="anthropicApiKey"
            label="Anthropic API key"
            hint="Stored encrypted on this machine (Windows DPAPI via Electron safeStorage) — never in plain text, never sent anywhere except api.anthropic.com. Get one at console.anthropic.com."
          />
          <label className="label">Model</label>
          <select className="input" value={s.model} onChange={(e) => useStore.setState({ model: e.target.value })}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            {!MODELS.some((m) => m.id === s.model) && <option value={s.model}>{s.model}</option>}
          </select>
          <label className="label">Custom model id (optional)</label>
          <input className="input" placeholder="e.g. claude-sonnet-4-6" defaultValue={s.model} onBlur={(e) => e.target.value.trim() && useStore.setState({ model: e.target.value.trim() })} />
          <label className="label">Max tokens per reply: {s.maxTokens}</label>
          <input type="range" min={512} max={8192} step={256} value={s.maxTokens} onChange={(e) => useStore.setState({ maxTokens: +e.target.value })} style={{ width: "100%", accentColor: "var(--ac)" }} />
        </div>
      )}

      {tab === "usage" && <UsageTab />}

      {tab === "voice" && (
        <div style={{ maxWidth: 480 }}>
          <label className="checkbox-row">
            <input type="checkbox" checked={s.settings.ttsEnabled} onChange={(e) => patchSettings({ ttsEnabled: e.target.checked })} />
            Read replies aloud automatically
          </label>
          <label className="label">Voice</label>
          <select className="input" value={s.settings.ttsVoice} onChange={(e) => patchSettings({ ttsVoice: e.target.value })}>
            <option value="">System default</option>
            {voices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
          </select>
          <label className="label">Speed: {s.settings.ttsRate.toFixed(1)}×</label>
          <input type="range" min={0.5} max={2} step={0.1} value={s.settings.ttsRate} onChange={(e) => patchSettings({ ttsRate: +e.target.value })} style={{ width: "100%", accentColor: "var(--ac)" }} />
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => speak("Hello! This is how I sound.", s.settings.ttsVoice, s.settings.ttsRate)}>▶ Test voice</button>
          <hr className="divider" />
          <SecretField
            name="openaiApiKey"
            label="OpenAI API key (for dictation, optional)"
            hint="The built-in browser speech engine isn't available in desktop shells, so ARIA records your mic and transcribes with Whisper instead — this key enables that. Without it: Windows dictation (Win+H) works in any text box, and text-to-speech works regardless."
          />
        </div>
      )}

      {tab === "workspace" && (
        <div style={{ maxWidth: 540 }}>
          <p className="hint">Describe your organisation — agents reference these people, teams and roles naturally.</p>
          <label className="label">Organisation name</label>
          <input className="input" value={s.workspace?.org ?? ""} onChange={(e) => useStore.setState({ workspace: { org: e.target.value, departments: s.workspace?.departments ?? [], roles: s.workspace?.roles ?? [], employees: s.workspace?.employees ?? [] } })} />
          <label className="label">Departments (one per line)</label>
          <textarea className="ta" rows={3} value={(s.workspace?.departments ?? []).join("\n")} onChange={(e) => useStore.setState({ workspace: { org: s.workspace?.org ?? "", departments: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean), roles: s.workspace?.roles ?? [], employees: s.workspace?.employees ?? [] } })} />
          <label className="label">Roles (one per line)</label>
          <textarea className="ta" rows={3} value={(s.workspace?.roles ?? []).join("\n")} onChange={(e) => useStore.setState({ workspace: { org: s.workspace?.org ?? "", departments: s.workspace?.departments ?? [], roles: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean), employees: s.workspace?.employees ?? [] } })} />
          <label className="label">People (Name · Role, one per line)</label>
          <textarea className="ta" rows={4} value={(s.workspace?.employees ?? []).map((e) => e.name + (e.role ? " · " + e.role : "")).join("\n")} onChange={(e) => useStore.setState({
            workspace: {
              org: s.workspace?.org ?? "", departments: s.workspace?.departments ?? [], roles: s.workspace?.roles ?? [],
              employees: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean).map((line) => {
                const [name, role] = line.split("·").map((x) => x.trim());
                return { name, role: role || undefined };
              }),
            },
          })} />
        </div>
      )}

      {tab === "web" && (
        <div style={{ maxWidth: 540 }}>
          <label className="checkbox-row">
            <input type="checkbox" checked={s.settings.webResearchMode} onChange={(e) => patchSettings({ webResearchMode: e.target.checked })} />
            <b>Enable live web research</b>
          </label>
          <p className="hint">
            Off by default. When on, messages that look like they need current information trigger a quick web search;
            results are summarised with source badges. Works with no extra keys (public reader service); add keys below for better search.
          </p>
          <label className="checkbox-row">
            <input type="checkbox" checked={s.settings.autoSaveResearch} onChange={(e) => patchSettings({ autoSaveResearch: e.target.checked })} />
            Offer to save research findings into Knowledge
          </label>
          <hr className="divider" />
          <SecretField name="braveApiKey" label="Brave Search API key (optional)" hint="Free tier at brave.com/search/api — improves search quality." />
          <SecretField name="jinaApiKey" label="Jina Reader API key (optional)" hint="Raises rate limits for page reading (r.jina.ai)." />
        </div>
      )}

      {tab === "admin" && (
        <div style={{ maxWidth: 540 }}>
          <p className="hint">
            Admin rules constrain every agent's behaviour (useful when others use this machine).
            The passphrase is set locally and stored hashed — there is no master password or override built into the app.
          </p>
          <label className="label">Admin passphrase {s.settings.adminPasswordHash ? "(set)" : "(not set)"}</label>
          <div className="row">
            <input className="input grow" type="password" placeholder={s.settings.adminPasswordHash ? "Enter new passphrase to change" : "Set a passphrase"} value={adminPw} onChange={(e) => setAdminPw(e.target.value)} />
            <button className="btn sm" disabled={!adminPw.trim()} onClick={() => {
              patchSettings({ adminPasswordHash: hashPw(adminPw.trim()) });
              setAdminPw("");
              toast("Admin passphrase updated", "ok");
            }}>Save</button>
            {s.settings.adminPasswordHash && (
              <button className="btn sm danger" onClick={() => { patchSettings({ adminPasswordHash: "" }); toast("Admin passphrase removed", "ok"); }}>Remove</button>
            )}
          </div>
          <hr className="divider" />
          <label className="checkbox-row"><input type="checkbox" checked={s.settings.adminRules.enabled} onChange={(e) => patchRules({ enabled: e.target.checked })} /> <b>Enforce admin rules</b></label>
          <label className="checkbox-row"><input type="checkbox" checked={s.settings.adminRules.noPersonalAdvice} onChange={(e) => patchRules({ noPersonalAdvice: e.target.checked })} /> No personal legal/medical/financial advice</label>
          <label className="checkbox-row"><input type="checkbox" checked={s.settings.adminRules.formalOnly} onChange={(e) => patchRules({ formalOnly: e.target.checked })} /> Formal tone only</label>
          <label className="checkbox-row"><input type="checkbox" checked={s.settings.adminRules.noOffTopic} onChange={(e) => patchRules({ noOffTopic: e.target.checked })} /> Block off-topic subjects:</label>
          <input className="input" placeholder="e.g. politics, gossip" value={s.settings.adminRules.offTopicBlock} onChange={(e) => patchRules({ offTopicBlock: e.target.value })} />
          <label className="label">Custom rule</label>
          <textarea className="ta" rows={2} value={s.settings.adminRules.customRule} onChange={(e) => patchRules({ customRule: e.target.value })} />
        </div>
      )}

      {tab === "data" && (
        <div style={{ maxWidth: 540 }}>
          <p className="hint">All your data lives on this machine in the app's data folder. No account, no cloud.</p>
          <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={async () => {
              await flushSave();
              const path = await window.aria.store.exportBackup(serializeState(useStore.getState()));
              if (path) toast("Backup saved to " + path, "ok");
            }}>⬇ Export backup (JSON)</button>
            <button className="btn" onClick={async () => {
              const raw = await window.aria.store.importBackup();
              if (!raw) return;
              try {
                const { migrated } = await applyImport(JSON.parse(raw));
                await flushSave();
                toast(migrated ? "Old-format backup imported and upgraded" : "Backup imported", "ok");
              } catch (e: any) {
                toast("Import failed: " + e.message, "err");
              }
            }}>⬆ Import backup</button>
            {window.aria.app.openBackups && (
              <button className="btn" onClick={() => void window.aria.app.openBackups!()}>📂 Open backups folder</button>
            )}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            ARIA also snapshots your data automatically once a day (the 7 newest are kept in the backups folder).
          </p>
          <hr className="divider" />
          <h3 style={{ margin: "0 0 4px" }}>🗑 Trash</h3>
          <TrashSection />
          <hr className="divider" />
          <button className="btn danger" onClick={() => setConfirmWipe(true)}>🗑 Wipe all data…</button>
          {confirmWipe && (
            <ConfirmModal
              title="Wipe ALL data?"
              body="This deletes every conversation, agent, document, task and your stored API keys from this machine. Export a backup first if you might want any of it back."
              confirmLabel="Wipe everything"
              danger
              onClose={() => setConfirmWipe(false)}
              onConfirm={async () => {
                await window.aria.store.wipe();
                window.location.reload();
              }}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
