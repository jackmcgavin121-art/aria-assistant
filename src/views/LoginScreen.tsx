import { useState } from "react";
import { useStore, flushSave } from "../store/store";
import { login, redeemInvite, recoverAdmin, setupWorkspace, signInAs } from "../lib/auth";
import { importOrgProfile } from "../features/orgProfile";

type Step = "choose" | "adminLogin" | "adminSetup" | "recoveryKey" | "recover" | "staffLogin" | "staffJoin";

/**
 * Pre-app auth flow, shown whenever Team access is on and nobody is signed
 * in. Lands on an admin/staff chooser; the admin path leads to login or (on
 * a fresh workspace) the setup wizard; the staff path leads to login, invite-
 * code signup, or importing the organisation profile on a new PC.
 */
export function LoginScreen() {
  const hasAdmin = useStore((s) => s.accounts.some((a) => a.role === "admin"));
  const [step, setStep] = useState<Step>("choose");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");

  return (
    <div className="login-screen">
      <div className={"login-card" + (step === "choose" ? " wide" : "")}>
        <Header />
        {step === "choose" && (
          <Chooser
            onAdmin={() => setStep(hasAdmin ? "adminLogin" : "adminSetup")}
            onStaff={() => setStep("staffLogin")}
          />
        )}
        {step === "adminLogin" && <AdminLogin onBack={() => setStep("choose")} onRecover={() => setStep("recover")} />}
        {step === "adminSetup" && (
          <AdminSetup
            onBack={() => setStep("choose")}
            onDone={(key, email) => {
              setRecoveryKey(key);
              setPendingEmail(email);
              setStep("recoveryKey");
            }}
          />
        )}
        {step === "recoveryKey" && (
          <RecoveryKeyScreen
            recoveryKey={recoveryKey}
            onDone={() => {
              setRecoveryKey("");
              signInAs(pendingEmail); // gate closes, app opens
            }}
          />
        )}
        {step === "recover" && <Recover onBack={() => setStep("adminLogin")} />}
        {step === "staffLogin" && <StaffLogin onBack={() => setStep("choose")} onJoin={() => setStep("staffJoin")} />}
        {step === "staffJoin" && <StaffJoin onBack={() => setStep("staffLogin")} />}
      </div>
    </div>
  );
}

function Header() {
  const org = useStore((s) => s.workspace?.org);
  return (
    <>
      <div className="sb-logo" style={{ justifyContent: "center", fontSize: 22, marginBottom: 4 }}>
        <span className="dot" /> ARIA
      </div>
      <p className="hint" style={{ textAlign: "center", margin: "0 0 14px" }}>
        {org ? org : "Sign in to your workspace"}
      </p>
    </>
  );
}

function Chooser({ onAdmin, onStaff }: { onAdmin: () => void; onStaff: () => void }) {
  const hasAdmin = useStore((s) => s.accounts.some((a) => a.role === "admin"));
  const authEnabled = useStore((s) => s.settings.authEnabled);
  return (
    <>
      <div className="login-choose">
        <button className="login-role" onClick={onAdmin}>
          <span className="big">🛡</span>
          <b>Administrator</b>
          <span className="hint">{hasAdmin ? "Sign in to manage the workspace" : "Set up this workspace"}</span>
        </button>
        <button className="login-role" onClick={onStaff}>
          <span className="big">👤</span>
          <b>Staff</b>
          <span className="hint">Sign in or join with an invite code</span>
        </button>
      </div>
      <p className="hint" style={{ textAlign: "center", marginTop: 12, marginBottom: 0 }}>
        New here?{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); void window.aria.app.openExternal("https://jackmcgavin121-art.github.io/aria-assistant/"); }}>
          Read the setup guide
        </a>
      </p>
      {/* First-run only: solo users can opt out of logins entirely. */}
      {!authEnabled && (
        <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              const s = useStore.getState();
              useStore.setState({ settings: { ...s.settings, authSetupDismissed: true } });
            }}
          >
            It's just me on this PC — skip logins
          </a>{" "}
          <span>(you can turn them on later in Settings → Team access)</span>
        </p>
      )}
    </>
  );
}

function BackLink({ onBack, label = "‹ Back" }: { onBack: () => void; label?: string }) {
  return (
    <button className="btn ghost sm" style={{ marginBottom: 8 }} onClick={onBack}>
      {label}
    </button>
  );
}

/** Email+password sign-in form, shared by the admin and staff paths. */
function LoginForm({ adminOnly, extra }: { adminOnly?: boolean; extra?: React.ReactNode }) {
  const lastEmail = useStore((s) => s.settings.lastLoginEmail);
  const [email, setEmail] = useState(lastEmail ?? "");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    // The admin door only opens for admins — staff have their own door.
    const e = await login(email, pw, adminOnly ? "admin" : undefined);
    setBusy(false);
    if (e) setErr(e);
  };

  return (
    <>
      <label className="label">Email</label>
      <input
        className="input"
        type="email"
        autoFocus={!lastEmail}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="you@company.com"
      />
      <label className="label">Password</label>
      <input
        className="input"
        type="password"
        autoFocus={!!lastEmail}
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="••••••••"
      />
      {err && <p className="login-err">{err}</p>}
      <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void submit()}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {extra}
    </>
  );
}

function AdminLogin({ onBack, onRecover }: { onBack: () => void; onRecover: () => void }) {
  return (
    <>
      <BackLink onBack={onBack} />
      <h3 style={{ margin: "0 0 8px" }}>🛡 Administrator sign-in</h3>
      <LoginForm
        adminOnly
        extra={
          <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
            Locked out?{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); onRecover(); }}>Use your recovery key</a>
          </p>
        }
      />
    </>
  );
}

function AdminSetup({ onBack, onDone }: { onBack: () => void; onDone: (recoveryKey: string, email: string) => void }) {
  const orgName0 = useStore((s) => s.workspace?.org ?? "");
  const [org, setOrg] = useState(orgName0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (pw !== pw2) return setErr("The passwords don't match.");
    setBusy(true);
    setErr("");
    const r = await setupWorkspace({ orgName: org, email, password: pw, name });
    setBusy(false);
    if ("error" in r) setErr(r.error);
    else onDone(r.recoveryKey, email);
  };

  return (
    <>
      <BackLink onBack={onBack} />
      <h3 style={{ margin: "0 0 4px" }}>🏢 Set up your workspace</h3>
      <p className="hint" style={{ margin: "0 0 10px" }}>
        You become the administrator: you'll manage staff accounts, invite codes and company setup.
      </p>
      <label className="label">Workspace / company name</label>
      <input className="input" autoFocus value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Acme Ltd" />
      <label className="label">Your name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jack" />
      <label className="label">Email</label>
      <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
      <label className="label">Password (8+ characters)</label>
      <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <label className="label">Confirm password</label>
      <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
      {err && <p className="login-err">{err}</p>}
      <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void submit()}>
        {busy ? "Setting up…" : "Create workspace"}
      </button>
    </>
  );
}

function RecoveryKeyScreen({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <h3 style={{ margin: "0 0 4px" }}>🔑 Your recovery key</h3>
      <p className="hint">
        If every admin password is forgotten, this key is the <b>only</b> way back in. It's shown once —
        store it somewhere safe (password manager, printed in a drawer), not in ARIA.
      </p>
      <div className="login-reckey">{recoveryKey}</div>
      <button
        className="btn"
        style={{ width: "100%", marginTop: 8 }}
        onClick={async () => {
          // Never let a clipboard failure trap the user on this screen — the
          // key text is selectable, so they can always copy it by hand.
          setCopied(true);
          try {
            await navigator.clipboard.writeText(recoveryKey);
            toast("Recovery key copied", "ok");
          } catch {
            toast("Couldn't reach the clipboard — select the key text and copy it manually.", "err");
          }
        }}
      >
        📋 Copy key
      </button>
      <button
        className="btn primary"
        style={{ width: "100%", marginTop: 8 }}
        disabled={!copied}
        title={copied ? undefined : "Copy the key first"}
        onClick={onDone}
      >
        I've stored it — open ARIA
      </button>
    </>
  );
}

function Recover({ onBack }: { onBack: () => void }) {
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);

  const submit = async () => {
    if (busy) return;
    if (pw !== pw2) return setErr("The passwords don't match.");
    setBusy(true);
    setErr("");
    const e = await recoverAdmin(key, email, pw);
    setBusy(false);
    if (e) setErr(e);
    else toast("Password reset — generate a NEW recovery key in Settings → Team access.", "info");
  };

  return (
    <>
      <BackLink onBack={onBack} />
      <h3 style={{ margin: "0 0 4px" }}>🔑 Admin recovery</h3>
      <p className="hint" style={{ margin: "0 0 10px" }}>
        Enter the recovery key from workspace setup to reset an admin password. The key is single-use.
      </p>
      <label className="label">Recovery key</label>
      <input className="input" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="ARIA-XXXX-XXXX-XXXX-XXXX" style={{ fontFamily: "var(--mono)" }} />
      <label className="label">Admin email</label>
      <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
      <label className="label">New password (8+ characters)</label>
      <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <label className="label">Confirm new password</label>
      <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
      {err && <p className="login-err">{err}</p>}
      <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void submit()}>
        {busy ? "Checking…" : "Reset password & sign in"}
      </button>
    </>
  );
}

function StaffLogin({ onBack, onJoin }: { onBack: () => void; onJoin: () => void }) {
  const toast = useStore((s) => s.toast);
  const hasAccounts = useStore((s) => s.accounts.length > 0);

  const importProfile = async () => {
    const raw = await window.aria.store.importBackup();
    if (!raw) return;
    try {
      const r = importOrgProfile(JSON.parse(raw));
      await flushSave();
      toast(`Workspace loaded — ${r.accounts} account${r.accounts === 1 ? "" : "s"} available. Sign in below.`, "ok");
    } catch (e: any) {
      toast("Import failed: " + e.message, "err");
    }
  };

  return (
    <>
      <BackLink onBack={onBack} />
      <h3 style={{ margin: "0 0 8px" }}>👤 Staff sign-in</h3>
      {!hasAccounts && (
        <p className="hint">
          This PC has no workspace yet — import the organisation profile file your administrator gave you.
        </p>
      )}
      <LoginForm
        extra={
          <div className="hint" style={{ textAlign: "center", marginTop: 12, display: "grid", gap: 4 }}>
            <span>
              First time here?{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); onJoin(); }}>Join with an invite code</a>
            </span>
            <span>
              New PC?{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); void importProfile(); }}>Import organisation profile…</a>
            </span>
            <span>No login? Ask your administrator.</span>
          </div>
        }
      />
    </>
  );
}

function StaffJoin({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (pw !== pw2) return setErr("The passwords don't match.");
    setBusy(true);
    setErr("");
    const e = await redeemInvite(code, email, pw, name);
    setBusy(false);
    if (e) setErr(e);
  };

  return (
    <>
      <BackLink onBack={onBack} />
      <h3 style={{ margin: "0 0 4px" }}>🎟 Join with an invite code</h3>
      <p className="hint" style={{ margin: "0 0 10px" }}>
        Your administrator gives you a code or a join link; you pick your own password.
      </p>
      <label className="label">Invite code or join link</label>
      <input className="input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX or ARIA-JOIN-…" style={{ fontFamily: "var(--mono)" }} />
      <label className="label">Your name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam" />
      <label className="label">Email</label>
      <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
      <label className="label">Choose a password (8+ characters)</label>
      <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <label className="label">Confirm password</label>
      <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} />
      {err && <p className="login-err">{err}</p>}
      <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void submit()}>
        {busy ? "Creating account…" : "Create account & sign in"}
      </button>
    </>
  );
}
