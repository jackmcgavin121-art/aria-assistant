// Local login accounts. This is an access gate for the app UI on this
// machine — passwords are salted PBKDF2-SHA256 hashes (never plaintext),
// but the data files on disk are not encrypted by it. There is no server:
// accounts travel between machines inside the organisation profile file.
import { useStore } from "../store/store";
import type { Account } from "../types";
import { uid } from "./util";

const PBKDF2_ITERATIONS = 120_000;

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

/** Returns an error message, or null on success (currentUser is set). */
export async function login(email: string, password: string): Promise<string | null> {
  if (!email.trim() || !password) return "Enter your email and password.";
  const acc = findAccount(email);
  if (!acc) return "No account with that email — ask your administrator.";
  const { hash } = await hashPassword(password, acc.salt);
  if (hash !== acc.passHash) return "Wrong password.";
  useStore.setState({ currentUser: { email: acc.email, role: acc.role, name: acc.name } });
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
  if (password.length < 6) return "Password must be at least 6 characters.";
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
  if (newPassword.length < 6) return "Password must be at least 6 characters.";
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
  const acc = findAccount(email)!;
  useStore.setState({
    settings: { ...s.settings, authEnabled: true },
    currentUser: { email: acc.email, role: acc.role, name: acc.name },
  });
  return null;
}

export function disableAuth() {
  const s = useStore.getState();
  useStore.setState({ settings: { ...s.settings, authEnabled: false } });
}
