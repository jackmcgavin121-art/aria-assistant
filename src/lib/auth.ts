// Local login accounts. This is an access gate for the app UI on this
// machine — passwords are salted PBKDF2-SHA256 hashes (never plaintext),
// but the data files on disk are not encrypted by it. There is no server:
// accounts travel between machines inside the organisation profile file.
import { useStore } from "../store/store";
import type { Account, Invite } from "../types";
import { uid } from "./util";

const PBKDF2_ITERATIONS = 120_000;
const MIN_PASSWORD_LEN = 8;
/** Wrong guesses allowed before the escalating lockout kicks in. */
const THROTTLE_FREE_FAILS = 5;
const THROTTLE_BASE_MS = 30_000; // 30s, doubling per extra fail
const THROTTLE_MAX_MS = 15 * 60_000;
const INVITE_TTL_MS = 7 * 864e5; // codes expire after 7 days

/** Unambiguous alphabet for codes typed by hand (no 0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomCode(groups: number, groupLen = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(groups * groupLen));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * groupLen, (g + 1) * groupLen).join(""));
  return out.join("-");
}

const normCode = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ salt: string; hash: string }> {
  const salt = saltHex ?? toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return { salt, hash: toHex(bits) };
}

const normEmail = (e: string) => e.trim().toLowerCase();

export function findAccount(email: string): Account | undefined {
  return useStore.getState().accounts.find((a) => normEmail(a.email) === normEmail(email));
}

/** Human-readable "try again in …" for the lockout message. */
function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`;
}

function throttleCheck(): string | null {
  const t = useStore.getState().settings.loginThrottle;
  if (t && t.lockedUntil > Date.now()) {
    return `Too many wrong attempts — try again in ${waitText(t.lockedUntil - Date.now())}.`;
  }
  return null;
}

function throttleFail() {
  const s = useStore.getState();
  const fails = (s.settings.loginThrottle?.fails ?? 0) + 1;
  const over = fails - THROTTLE_FREE_FAILS;
  const lockedUntil =
    over >= 0 ? Date.now() + Math.min(THROTTLE_BASE_MS * 2 ** over, THROTTLE_MAX_MS) : 0;
  useStore.setState({ settings: { ...s.settings, loginThrottle: { fails, lockedUntil } } });
}

function throttleClear() {
  const s = useStore.getState();
  if (s.settings.loginThrottle) useStore.setState({ settings: { ...s.settings, loginThrottle: undefined } });
}

function signIn(acc: Account) {
  const s = useStore.getState();
  useStore.setState({
    currentUser: { email: acc.email, role: acc.role, name: acc.name },
    settings: { ...s.settings, lastLoginEmail: acc.email, loginThrottle: undefined },
  });
}

/**
 * Returns an error message, or null on success (currentUser is set).
 * `requireRole` rejects BEFORE signing in — setting currentUser and then
 * reverting would flash the app shell for a moment.
 */
export async function login(email: string, password: string, requireRole?: Account["role"]): Promise<string | null> {
  if (!email.trim() || !password) return "Enter your email and password.";
  const locked = throttleCheck();
  if (locked) return locked;
  const acc = findAccount(email);
  if (!acc) return "No account with that email — ask your administrator.";
  const { hash } = await hashPassword(password, acc.salt);
  if (hash !== acc.passHash) {
    throttleFail();
    return throttleCheck() ?? "Wrong password.";
  }
  if (requireRole && acc.role !== requireRole) {
    return acc.role === "staff"
      ? "That account isn't an administrator — use the Staff sign-in."
      : "That's an administrator account — use the Administrator sign-in.";
  }
  signIn(acc);
  return null;
}

export function logout() {
  useStore.setState({ currentUser: null });
}

/** Create an account. Returns an error message, or null on success. */
export async function createAccount(
  email: string,
  password: string,
  role: Account["role"],
  name?: string
): Promise<string | null> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "That doesn't look like an email address.";
  if (password.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
  if (findAccount(email)) return "An account with that email already exists.";
  const { salt, hash } = await hashPassword(password);
  const acc: Account = {
    id: uid(),
    email: email.trim(),
    name: name?.trim() || undefined,
    role,
    passHash: hash,
    salt,
    createdAt: Date.now(),
  };
  const s = useStore.getState();
  useStore.setState({ accounts: [...s.accounts, acc] });
  return null;
}

/** Removing the last admin while login is on would lock everyone out. */
export function removeAccount(id: string): string | null {
  const s = useStore.getState();
  const acc = s.accounts.find((a) => a.id === id);
  if (!acc) return null;
  const admins = s.accounts.filter((a) => a.role === "admin");
  if (acc.role === "admin" && admins.length === 1 && s.settings.authEnabled) {
    return "You can't remove the only admin account while login is on. Add another admin or turn login off first.";
  }
  useStore.setState({ accounts: s.accounts.filter((a) => a.id !== id) });
  return null;
}

export async function resetPassword(id: string, newPassword: string): Promise<string | null> {
  if (newPassword.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
  const { salt, hash } = await hashPassword(newPassword);
  const s = useStore.getState();
  useStore.setState({
    accounts: s.accounts.map((a) => (a.id === id ? { ...a, passHash: hash, salt } : a)),
  });
  return null;
}

/** Turn the login gate on, creating the first admin and signing them in. */
export async function enableAuth(email: string, password: string, name?: string): Promise<string | null> {
  const existing = findAccount(email);
  if (!existing) {
    const err = await createAccount(email, password, "admin", name);
    if (err) return err;
  }
  const s = useStore.getState();
  useStore.setState({ settings: { ...s.settings, authEnabled: true } });
  signIn(findAccount(email)!);
  return null;
}

export function disableAuth() {
  const s = useStore.getState();
  useStore.setState({ settings: { ...s.settings, authEnabled: false } });
}

// ---------------------------------------------------------------------------
// Workspace setup (first admin + recovery key)

/**
 * Set up the workspace in one go: names the organisation, creates the first
 * admin, turns the login gate on, and generates the recovery key. The
 * plaintext key is returned ONCE for the admin to store — only its salted
 * hash is kept. The caller signs them in (signInAs) AFTER they've confirmed
 * the key is stored, so the key screen isn't unmounted by the login gate.
 */
export async function setupWorkspace(opts: {
  orgName: string;
  email: string;
  password: string;
  name?: string;
}): Promise<{ error: string } | { recoveryKey: string }> {
  const orgName = opts.orgName.trim();
  if (!orgName) return { error: "Give your workspace a name." };
  const email = opts.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That doesn't look like an email address." };
  if (opts.password.length < MIN_PASSWORD_LEN)
    return { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` };
  if (findAccount(email)) return { error: "An account with that email already exists." };

  const { salt, hash } = await hashPassword(opts.password);
  const key = "ARIA-" + randomCode(4);
  const rec = await hashPassword(key);

  // One atomic update: account + login gate + workspace name + recovery key.
  // Doing these as separate setState calls makes the app shell flash in
  // between (the login gate's mount condition changes), losing wizard state.
  // No signIn either — the caller signs in after the key is stored.
  const s = useStore.getState();
  const acc: Account = {
    id: uid(),
    email,
    name: opts.name?.trim() || undefined,
    role: "admin",
    passHash: hash,
    salt,
    createdAt: Date.now(),
  };
  useStore.setState({
    accounts: [...s.accounts, acc],
    workspace: s.workspace
      ? { ...s.workspace, org: orgName }
      : { org: orgName, departments: [], roles: [], employees: [] },
    settings: {
      ...s.settings,
      authEnabled: true,
      recoveryKey: { salt: rec.salt, hash: rec.hash, createdAt: Date.now() },
    },
  });
  return { recoveryKey: key };
}

/** Sign in an existing account without a password check — only for flows that already proved identity. */
export function signInAs(email: string): void {
  const acc = findAccount(email);
  if (acc) signIn(acc);
}

/** Create (or replace) the admin recovery key. Returns the plaintext key — shown once. */
export async function generateRecoveryKey(): Promise<string> {
  const key = "ARIA-" + randomCode(4);
  const { salt, hash } = await hashPassword(key);
  const s = useStore.getState();
  useStore.setState({ settings: { ...s.settings, recoveryKey: { salt, hash, createdAt: Date.now() } } });
  return key;
}

/**
 * Locked-out admin recovery: a valid recovery key resets the given admin
 * account's password and signs them in. The used key is discarded — the
 * admin should generate a fresh one from Settings.
 */
export async function recoverAdmin(key: string, email: string, newPassword: string): Promise<string | null> {
  const locked = throttleCheck();
  if (locked) return locked;
  const s = useStore.getState();
  const rec = s.settings.recoveryKey;
  if (!rec) return "No recovery key was set up for this workspace.";
  // Canonicalise whatever they typed (spaces/dashes/case don't matter) back
  // to the "ARIA-XXXX-XXXX-XXXX-XXXX" form the hash was made from.
  const raw = normCode(key).replace(/^ARIA/, "");
  const canonical = "ARIA-" + (raw.match(/.{1,4}/g) ?? []).join("-");
  const { hash } = await hashPassword(canonical, rec.salt);
  if (hash !== rec.hash) {
    throttleFail();
    return throttleCheck() ?? "That recovery key isn't right.";
  }
  const acc = findAccount(email);
  if (!acc || acc.role !== "admin") return "No admin account with that email.";
  const err = await resetPassword(acc.id, newPassword);
  if (err) return err;
  // Single-use: drop the key so a written-down copy can't be replayed.
  const sAfter = useStore.getState();
  useStore.setState({ settings: { ...sAfter.settings, recoveryKey: undefined } });
  signIn({ ...acc });
  return null;
}

// ---------------------------------------------------------------------------
// Invite codes (staff self-signup without a server)

/** Create a single-use invite code. Returns the code to hand to the person. */
export function createInvite(role: Invite["role"], forName?: string): string {
  const invite: Invite = {
    id: uid(),
    code: randomCode(2),
    role,
    forName: forName?.trim() || undefined,
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
  const s = useStore.getState();
  useStore.setState({ invites: [...s.invites, invite] });
  return invite.code;
}

export function revokeInvite(id: string) {
  const s = useStore.getState();
  useStore.setState({ invites: s.invites.filter((i) => i.id !== id) });
}

export function activeInvites(): Invite[] {
  const now = Date.now();
  return useStore.getState().invites.filter((i) => !i.usedAt && i.expiresAt > now);
}

/**
 * Staff first sign-in with an invite code: creates their account with the
 * role the admin chose, marks the code used, and signs them in.
 */
export async function redeemInvite(
  code: string,
  email: string,
  password: string,
  name?: string
): Promise<string | null> {
  const locked = throttleCheck();
  if (locked) return locked;
  const wanted = normCode(code);
  if (!wanted) return "Enter your invite code.";
  const inv = useStore.getState().invites.find((i) => normCode(i.code) === wanted);
  if (!inv || inv.usedAt) {
    throttleFail();
    return throttleCheck() ?? "That invite code isn't valid — ask your administrator for a new one.";
  }
  if (inv.expiresAt < Date.now()) return "That invite code has expired — ask your administrator for a new one.";
  const err = await createAccount(email, password, inv.role, name);
  if (err) return err;
  const s = useStore.getState();
  useStore.setState({
    invites: s.invites.map((i) =>
      i.id === inv.id ? { ...i, usedAt: Date.now(), usedByEmail: email.trim() } : i
    ),
  });
  signIn(findAccount(email)!);
  return null;
}
