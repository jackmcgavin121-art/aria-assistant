import { useState } from "react";
import { login } from "../lib/auth";

/** Shown before the app when Settings → Team access has login turned on. */
export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    const e = await login(email, pw);
    setBusy(false);
    if (e) setErr(e);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="sb-logo" style={{ justifyContent: "center", fontSize: 22, marginBottom: 4 }}>
          <span className="dot" /> ARIA
        </div>
        <p className="hint" style={{ textAlign: "center", margin: "0 0 12px" }}>Sign in to your workspace</p>
        <label className="label">Email</label>
        <input
          className="input"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="you@company.com"
        />
        <label className="label">Password</label>
        <input
          className="input"
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="••••••••"
        />
        {err && <p className="login-err">{err}</p>}
        <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void submit()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
          No login? Ask your administrator — they manage accounts in Settings → Team access.
        </p>
      </div>
    </div>
  );
}
