import { useState } from "react";
import { useStore } from "../store/store";
import { Modal } from "../components/Modal";

// 3-step first-run onboarding: API key → business context → pick an agent.
export function Onboarding() {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState("");
  const agents = useStore((s) => s.agents);
  const profile = useStore((s) => s.profile);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const toast = useStore((s) => s.toast);

  const finish = () => {
    const s = useStore.getState();
    useStore.setState({ settings: { ...s.settings, onboarded: true }, onboardingOpen: false });
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    await window.aria.secrets.set("anthropicApiKey", key.trim());
    useStore.setState({ hasApiKey: true });
    setKey("");
    toast("API key saved (encrypted on this machine)", "ok");
    setStep(1);
  };

  const patchProfile = (patch: Partial<typeof profile>) =>
    useStore.setState({ profile: { ...useStore.getState().profile, ...patch } });

  return (
    <Modal
      title={`Welcome to ARIA — step ${step + 1} of 3`}
      onClose={finish}
      footer={
        <>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>← Back</button>}
          <span className="grow" />
          {step === 0 && (
            <>
              <button className="btn" onClick={() => setStep(1)}>Skip for now</button>
              <button className="btn primary" disabled={!key.trim() && !hasApiKey} onClick={() => (key.trim() ? void saveKey() : setStep(1))}>
                {hasApiKey && !key.trim() ? "Key already saved →" : "Save & continue →"}
              </button>
            </>
          )}
          {step === 1 && <button className="btn primary" onClick={() => setStep(2)}>Continue →</button>}
          {step === 2 && <button className="btn primary" onClick={finish}>Start working 🚀</button>}
        </>
      }
    >
      {step === 0 && (
        <div>
          <p style={{ lineHeight: 1.6 }}>
            ARIA is your AI team — specialist agents that chat, complete assigned tasks, and keep your company knowledge.
            It runs entirely on your machine with your own Anthropic API key.
          </p>
          <label className="label">Anthropic API key</label>
          <input className="input" type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
          <p className="hint" style={{ marginTop: 6 }}>
            Get one at console.anthropic.com → API keys. It's stored encrypted (Windows DPAPI) and only ever sent to api.anthropic.com.
          </p>
        </div>
      )}
      {step === 1 && (
        <div>
          <p style={{ lineHeight: 1.6 }}>Tell ARIA about your business so every agent starts with context. (All optional — you can refine it later in Knowledge → Business profile.)</p>
          <div className="row">
            <div className="grow">
              <label className="label">Your name</label>
              <input className="input" value={profile.name} onChange={(e) => patchProfile({ name: e.target.value })} />
            </div>
            <div className="grow">
              <label className="label">Your role</label>
              <input className="input" value={profile.jobRole} onChange={(e) => patchProfile({ jobRole: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <label className="label">Company</label>
              <input className="input" value={profile.company} onChange={(e) => patchProfile({ company: e.target.value })} />
            </div>
            <div className="grow">
              <label className="label">Industry</label>
              <input className="input" value={profile.industry} onChange={(e) => patchProfile({ industry: e.target.value })} />
            </div>
          </div>
        </div>
      )}
      {step === 2 && (
        <div>
          <p style={{ lineHeight: 1.6 }}>Pick who to talk to first. Your starting roster has {agents.length} agents — add more from Agents → Industry packs.</p>
          <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))" }}>
            {agents.map((a) => (
              <div key={a.id} className="card clickable" onClick={() => { useStore.setState({ activeAgentId: a.id }); finish(); }}>
                <h3><span style={{ fontSize: 20 }}>{a.emoji}</span> {a.name}</h3>
                <div className="sub">{a.role}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
