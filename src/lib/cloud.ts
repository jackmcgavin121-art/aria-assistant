// Cloud workspace client (Stage 2). Talks straight to a Supabase project
// over REST — GoTrue for identity, PostgREST for the workspace directory
// (see supabase/schema.sql). Design rule: the cloud only answers "who are
// you, which workspace, what has it paid for". All business data stays on
// disk, and a cached entitlement keeps the app working offline for 14 days.
import { useStore } from "../store/store";
import type { Account, CloudConfig, CloudEntitlement } from "../types";
import { hashPassword } from "./auth";

export const OFFLINE_GRACE_MS = 14 * 864e5;

/** Thrown for connectivity problems (vs. the server saying "no"). */
export class CloudOffline extends Error {
  constructor() {
    super("Couldn't reach the workspace server.");
  }
}

interface CloudSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  userId: string;
  email: string;
}

export function cloudConfig(): CloudConfig | undefined {
  return useStore.getState().settings.cloud;
}

function baseHeaders(cfg: CloudConfig): Record<string, string> {
  return { apikey: cfg.anonKey, "content-type": "application/json" };
}

async function http(cfg: CloudConfig, path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...baseHeaders(cfg), ...(init.headers as Record<string, string>) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  try {
    return await fetch(cfg.url.replace(/\/+$/, "") + path, { ...init, headers });
  } catch {
    throw new CloudOffline();
  }
}

/** Best human-readable message out of a GoTrue/PostgREST error body. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j.msg || j.message || j.error_description || j.error || j.hint || `Server error (${res.status})`;
  } catch {
    return `Server error (${res.status})`;
  }
}

// ------------------------------------------------------------------ session

async function saveSession(s: CloudSession | null): Promise<void> {
  await window.aria.cloudSession?.set(s ? JSON.stringify(s) : "");
}

async function loadSession(): Promise<CloudSession | null> {
  try {
    const raw = await window.aria.cloudSession?.get();
    return raw ? (JSON.parse(raw) as CloudSession) : null;
  } catch {
    return null;
  }
}

function sessionFromTokenResponse(j: any): CloudSession {
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - 30_000,
    userId: j.user?.id,
    email: j.user?.email,
  };
}

/** A valid access token, refreshing when needed. Null = signed out of the cloud. */
export async function getCloudSession(): Promise<CloudSession | null> {
  const cfg = cloudConfig();
  if (!cfg) return null;
  const s = await loadSession();
  if (!s) return null;
  if (s.expiresAt > Date.now()) return s;
  const res = await http(cfg, "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: s.refreshToken }),
  });
  if (!res.ok) {
    await saveSession(null); // refresh token revoked/expired — full sign-in needed
    return null;
  }
  const fresh = sessionFromTokenResponse(await res.json());
  await saveSession(fresh);
  return fresh;
}

// ------------------------------------------------------------------ config

/** Validate + store the project connection (Settings → Team access → Cloud). */
export async function connectCloud(url: string, anonKey: string): Promise<string | null> {
  const clean = url.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(clean)) {
    return "That doesn't look like a Supabase project URL (https://xxxx.supabase.co).";
  }
  if (!anonKey.trim()) return "Paste the project's anon/publishable key.";
  const cfg: CloudConfig = { url: clean, anonKey: anonKey.trim() };
  let res: Response;
  try {
    res = await http(cfg, "/auth/v1/health", { method: "GET" });
  } catch {
    return "Couldn't reach that project — check the URL and your connection.";
  }
  if (!res.ok) return "The project answered but rejected the key — check the anon key.";
  const s = useStore.getState();
  useStore.setState({ settings: { ...s.settings, cloud: cfg } });
  return null;
}

export async function disconnectCloud(): Promise<void> {
  const cfg = cloudConfig();
  const sess = await loadSession();
  if (cfg && sess) void http(cfg, "/auth/v1/logout", { method: "POST", token: sess.accessToken }).catch(() => {});
  await saveSession(null);
  const s = useStore.getState();
  useStore.setState({
    settings: { ...s.settings, cloud: undefined, cloudEntitlement: undefined },
    // Cloud mirror accounts are useless without the cloud.
    accounts: s.accounts.filter((a) => !a.id.startsWith("cloud-")),
  });
}

// ------------------------------------------------------------------ auth

interface Membership {
  org_id: string;
  role: "admin" | "staff";
  name?: string;
  organisations: { name: string; plan: string; status: string; seat_limit: number };
}

async function fetchMembership(cfg: CloudConfig, sess: CloudSession): Promise<Membership | null> {
  const res = await http(
    cfg,
    `/rest/v1/memberships?user_id=eq.${sess.userId}&status=eq.active&select=org_id,role,name,organisations(name,plan,status,seat_limit)`,
    { method: "GET", token: sess.accessToken }
  );
  if (!res.ok) throw new Error(await errorMessage(res));
  const rows: Membership[] = await res.json();
  const orgId = cfg.orgId;
  return rows.find((r) => r.org_id === orgId) ?? rows[0] ?? null;
}

/**
 * Mirror the signed-in cloud user as a local account so the same email +
 * password keep working offline (normal local login path, within grace).
 */
async function mirrorLocalAccount(email: string, password: string, role: Account["role"], name?: string) {
  const { salt, hash } = await hashPassword(password);
  const s = useStore.getState();
  const id = "cloud-" + email.trim().toLowerCase();
  const acc: Account = {
    id,
    email: email.trim(),
    name,
    role,
    passHash: hash,
    salt,
    createdAt: s.accounts.find((a) => a.id === id)?.createdAt ?? Date.now(),
  };
  useStore.setState({ accounts: [...s.accounts.filter((a) => a.id !== id), acc] });
}

function applyMembership(cfg: CloudConfig, m: Membership, ent?: Partial<CloudEntitlement>) {
  const s = useStore.getState();
  useStore.setState({
    settings: {
      ...s.settings,
      authEnabled: true,
      cloud: { ...cfg, orgId: m.org_id, orgName: m.organisations?.name ?? cfg.orgName },
      cloudEntitlement: {
        plan: m.organisations?.plan ?? "free",
        status: m.organisations?.status ?? "active",
        seatLimit: m.organisations?.seat_limit ?? 0,
        seatsUsed: ent?.seatsUsed ?? s.settings.cloudEntitlement?.seatsUsed ?? 0,
        checkedAt: Date.now(),
      },
    },
  });
}

/**
 * Cloud sign-in. Returns an error string, or null on success (session saved,
 * local mirror updated, entitlement refreshed). Throws CloudOffline when the
 * server is unreachable so the caller can fall back to the offline mirror.
 */
export async function cloudSignIn(email: string, password: string): Promise<string | null> {
  const cfg = cloudConfig();
  if (!cfg) return "No cloud workspace is configured.";
  const res = await http(cfg, "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });
  if (!res.ok) return await errorMessage(res);
  const sess = sessionFromTokenResponse(await res.json());
  await saveSession(sess);
  const m = await fetchMembership(cfg, sess);
  if (!m) return "You're signed in but not a member of this workspace — join with an invite code first.";
  if ((m.organisations?.status ?? "active") === "cancelled") {
    return "This workspace's subscription has ended — the administrator can reactivate it.";
  }
  applyMembership(cfg, m);
  await mirrorLocalAccount(email, password, m.role, m.name ?? undefined);
  return null;
}

/** Create the cloud identity (signup). Null on success. */
export async function cloudSignUp(email: string, password: string, name?: string): Promise<string | null> {
  const cfg = cloudConfig();
  if (!cfg) return "No cloud workspace is configured.";
  const res = await http(cfg, "/auth/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password, data: { name: name?.trim() || undefined } }),
  });
  if (!res.ok) return await errorMessage(res);
  const j = await res.json();
  if (!j.access_token) {
    // Email confirmation is on in the project settings — supported, but the
    // person has to click the link first.
    return "Account created — confirm the email we sent you, then sign in.";
  }
  await saveSession(sessionFromTokenResponse(j));
  return null;
}

// ------------------------------------------------------------------ workspace ops (RPC)

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const cfg = cloudConfig();
  if (!cfg) throw new Error("No cloud workspace is configured.");
  const sess = await getCloudSession();
  if (!sess) throw new Error("Your cloud session expired — sign in again.");
  const res = await http(cfg, `/rest/v1/rpc/${fn}`, {
    method: "POST",
    token: sess.accessToken,
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

export async function createCloudOrg(orgName: string, adminName?: string): Promise<void> {
  const org = await rpc<{ id: string; name: string }>("create_organisation", {
    org_name: orgName,
    admin_name: adminName ?? null,
  });
  const cfg = cloudConfig()!;
  const sess = (await getCloudSession())!;
  const m = await fetchMembership({ ...cfg, orgId: org.id }, sess);
  if (m) applyMembership(cfg, m);
}

export async function redeemCloudInvite(code: string, memberName?: string): Promise<{ orgName: string; role: "admin" | "staff" }> {
  const rows = await rpc<{ org_id: string; org_name: string; role: "admin" | "staff" }[]>("redeem_invite", {
    invite_code: code,
    member_name: memberName ?? null,
  });
  const r = rows[0];
  if (!r) throw new Error("The invite couldn't be redeemed.");
  const cfg = cloudConfig()!;
  const sess = (await getCloudSession())!;
  const m = await fetchMembership({ ...cfg, orgId: r.org_id }, sess);
  if (m) applyMembership(cfg, m);
  return { orgName: r.org_name, role: r.role };
}

export interface CloudInvite {
  id: string;
  code: string;
  role: "admin" | "staff";
  for_name?: string;
  expires_at: string;
  used_at?: string;
}

export async function createCloudInvite(role: "admin" | "staff", forName?: string): Promise<CloudInvite> {
  const orgId = cloudConfig()?.orgId;
  if (!orgId) throw new Error("Create or join a cloud workspace first.");
  return await rpc<CloudInvite>("create_invite", { org: orgId, invite_role: role, invite_for: forName ?? null });
}

export interface CloudMember {
  user_id: string;
  role: "admin" | "staff";
  name?: string;
  status: string;
  created_at: string;
}

export async function listCloudMembers(): Promise<CloudMember[]> {
  const cfg = cloudConfig();
  if (!cfg?.orgId) return [];
  const sess = await getCloudSession();
  if (!sess) throw new Error("Your cloud session expired — sign in again.");
  const res = await http(cfg, `/rest/v1/memberships?org_id=eq.${cfg.orgId}&select=user_id,role,name,status,created_at&order=created_at`, {
    method: "GET",
    token: sess.accessToken,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return await res.json();
}

export async function listCloudInvites(): Promise<CloudInvite[]> {
  const cfg = cloudConfig();
  if (!cfg?.orgId) return [];
  const sess = await getCloudSession();
  if (!sess) throw new Error("Your cloud session expired — sign in again.");
  const res = await http(
    cfg,
    `/rest/v1/invites?org_id=eq.${cfg.orgId}&used_at=is.null&expires_at=gt.${new Date().toISOString()}&select=id,code,role,for_name,expires_at,used_at&order=created_at`,
    { method: "GET", token: sess.accessToken }
  );
  if (!res.ok) throw new Error(await errorMessage(res));
  return await res.json();
}

export async function revokeCloudInvite(id: string): Promise<void> {
  const cfg = cloudConfig();
  if (!cfg) return;
  const sess = await getCloudSession();
  if (!sess) throw new Error("Your cloud session expired — sign in again.");
  const res = await http(cfg, `/rest/v1/invites?id=eq.${id}`, { method: "DELETE", token: sess.accessToken });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// ------------------------------------------------------------------ shared company setup

/**
 * Publish the shared company setup (business framework only — the caller is
 * responsible for never passing chat-derived or credential data here).
 */
export async function publishSharedProfile(data: unknown): Promise<string> {
  const cfg = cloudConfig();
  if (!cfg?.orgId) throw new Error("Create or join a cloud workspace first.");
  const sess = await getCloudSession();
  if (!sess) throw new Error("Your cloud session expired — sign in again.");
  const updatedAt = new Date().toISOString();
  const res = await http(cfg, "/rest/v1/org_profiles", {
    method: "POST",
    token: sess.accessToken,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ org_id: cfg.orgId, data, updated_at: updatedAt, updated_by: sess.userId }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return updatedAt;
}

/** The workspace's shared company setup, or null when none was published yet. */
export async function fetchSharedProfile(): Promise<{ data: any; updatedAt: string } | null> {
  const cfg = cloudConfig();
  if (!cfg?.orgId) return null;
  const sess = await getCloudSession();
  if (!sess) return null;
  const res = await http(cfg, `/rest/v1/org_profiles?org_id=eq.${cfg.orgId}&select=data,updated_at`, {
    method: "GET",
    token: sess.accessToken,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const rows = await res.json();
  return rows[0] ? { data: rows[0].data, updatedAt: rows[0].updated_at } : null;
}

// ------------------------------------------------------------------ entitlement

/**
 * Is this install currently allowed to run? True while the workspace is in
 * good standing OR the last good check is within the 14-day offline grace.
 * No cloud configured = always true (local mode is unrestricted).
 */
export function entitlementOk(): { ok: boolean; reason?: string } {
  const s = useStore.getState().settings;
  if (!s.cloud?.orgId) return { ok: true };
  const e = s.cloudEntitlement;
  if (!e) return { ok: true }; // never checked (mid-setup) — don't lock out
  if (e.status === "cancelled") return { ok: false, reason: "This workspace's subscription has ended." };
  if (Date.now() - e.checkedAt > OFFLINE_GRACE_MS) {
    return { ok: false, reason: "ARIA couldn't verify the workspace for 14 days — connect to the internet and sign in." };
  }
  return { ok: true };
}

/** Refresh the cached entitlement from the server. Quietly keeps the cache on network failure. */
export async function refreshEntitlement(): Promise<void> {
  const cfg = cloudConfig();
  if (!cfg?.orgId) return;
  try {
    const sess = await getCloudSession();
    if (!sess) return;
    const m = await fetchMembership(cfg, sess);
    if (!m) return;
    const members = await listCloudMembers();
    applyMembership(cfg, m, { seatsUsed: members.filter((x) => x.status === "active").length });
  } catch {
    /* offline — the cached entitlement + grace window covers this */
  }
}
