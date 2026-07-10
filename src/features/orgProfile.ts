// Organisation profile: a portable file with the company setup — workspace
// org chart, business profile, agent roster (definitions/bios, no runtime
// state), and login accounts (password hashes only). Exported by an admin,
// imported on each staff machine so everyone runs the same workplace setup.
// Conversations, tasks, and knowledge documents are NOT included — those
// stay in full backups.
import { useStore } from "../store/store";
import type { Account, Agent, BusinessProfile, CloudConfig, Invite, WorkspaceOrg } from "../types";
import { uid } from "../lib/util";
import { publishSharedProfile, fetchSharedProfile } from "../lib/cloud";

/** The agent fields that define who the agent is (its "bio") — no runtime state. */
type AgentBio = Pick<
  Agent,
  | "name"
  | "emoji"
  | "role"
  | "personality"
  | "instructions"
  | "knowledge"
  | "expertise"
  | "stakeholders"
  | "autoExec"
  | "canWriteMemory"
  | "autonomyLevel"
  | "proactiveMode"
  | "model"
>;

export interface OrgProfileFile {
  ariaOrgProfile: 1;
  exportedAt: number;
  appVersion?: string;
  workspace: WorkspaceOrg | null;
  businessProfile: BusinessProfile;
  agents: AgentBio[];
  accounts: Account[];
  /** Unused invite codes so a staff PC can redeem them (added v2.4). */
  invites?: Invite[];
  /** Cloud workspace connection (URL + publishable anon key) so a staff PC is cloud-ready after one import. */
  cloud?: CloudConfig;
  authEnabled: boolean;
}

function agentBio(a: Agent): AgentBio {
  return {
    name: a.name,
    emoji: a.emoji,
    role: a.role,
    personality: a.personality,
    instructions: a.instructions,
    knowledge: a.knowledge,
    expertise: a.expertise,
    stakeholders: a.stakeholders,
    autoExec: a.autoExec,
    canWriteMemory: a.canWriteMemory,
    autonomyLevel: a.autonomyLevel,
    proactiveMode: a.proactiveMode,
    model: a.model,
  };
}

export async function exportOrgProfile(): Promise<void> {
  const s = useStore.getState();
  let appVersion: string | undefined;
  try {
    appVersion = (await window.aria.app.info()).version;
  } catch {
    /* fine without */
  }
  const file: OrgProfileFile = {
    ariaOrgProfile: 1,
    exportedAt: Date.now(),
    appVersion,
    workspace: s.workspace,
    businessProfile: s.businessProfile,
    agents: s.agents.map(agentBio),
    accounts: s.accounts,
    invites: s.invites.filter((i) => !i.usedAt && i.expiresAt > Date.now()),
    cloud: s.settings.cloud,
    authEnabled: !!s.settings.authEnabled,
  };
  const name = `aria-org-profile-${new Date().toISOString().slice(0, 10)}.json`;
  const path = await window.aria.store.exportBackup(JSON.stringify(file, null, 2), name);
  if (path) s.toast("Organisation profile saved to " + path, "ok");
}

/**
 * Apply an organisation profile. Agents are matched by name: existing ones
 * keep their id, queue, goals and history but take the imported bio; new
 * ones are added fresh. Accounts (when present) REPLACE the local list.
 */
export function importOrgProfile(data: any): { agentsUpdated: number; agentsAdded: number; accounts: number } {
  if (!data || typeof data !== "object" || data.ariaOrgProfile !== 1) {
    throw new Error("Not an ARIA organisation profile file.");
  }
  const s = useStore.getState();

  const { agents, updated, added } = mergeAgentBios(s.agents, data.agents);

  const accounts: Account[] = Array.isArray(data.accounts)
    ? data.accounts.filter((a: any) => a && a.email && a.passHash && a.salt)
    : [];

  // Merge unused imported invites with local ones (dedupe by code).
  const importedInvites: Invite[] = Array.isArray(data.invites)
    ? data.invites.filter((i: any) => i && i.code && !i.usedAt)
    : [];
  const localCodes = new Set(s.invites.map((i) => i.code));
  const invites = [...s.invites, ...importedInvites.filter((i) => !localCodes.has(i.code))];

  useStore.setState({
    agents,
    invites,
    workspace: data.workspace ?? s.workspace,
    businessProfile: { ...s.businessProfile, ...(data.businessProfile ?? {}) },
    ...(accounts.length ? { accounts } : {}),
    settings: {
      ...s.settings,
      // Only flip the login gate on when the file actually carries accounts.
      authEnabled: accounts.length ? !!data.authEnabled : s.settings.authEnabled,
      // Never overwrite an existing cloud connection with an imported one.
      cloud: s.settings.cloud ?? (data.cloud && data.cloud.url && data.cloud.anonKey ? data.cloud : undefined),
    },
  });
  return { agentsUpdated: updated, agentsAdded: added, accounts: accounts.length };
}

/** Merge imported agent bios into the local roster: match by name, keep runtime state, add new ones fresh. */
function mergeAgentBios(local: Agent[], incomingRaw: any): { agents: Agent[]; updated: number; added: number } {
  const incoming: AgentBio[] = Array.isArray(incomingRaw) ? incomingRaw.filter((a: any) => a && a.name) : [];
  let updated = 0;
  const agents: Agent[] = local.map((a) => {
    const match = incoming.find((b) => b.name.toLowerCase() === a.name.toLowerCase());
    if (!match) return a;
    updated++;
    return { ...a, ...match };
  });
  const fresh = incoming.filter((b) => !local.some((a) => a.name.toLowerCase() === b.name.toLowerCase()));
  for (const b of fresh) {
    agents.push({
      id: uid(),
      published: false,
      goals: [],
      taskQueue: [],
      memory: { learnings: [], patterns: "", gaps: [] },
      workday: { startedAt: Date.now(), tasksCompleted: [], initiativesStarted: [], learningsDiscovered: [], blockers: [] },
      ...b,
    });
  }
  return { agents, updated, added: fresh.length };
}

// ---------------------------------------------------------------------------
// Cloud-shared company setup (business framework only).
//
// THE CONFIDENTIALITY LINE: what syncs is the stuff an admin authored about
// the company — workspace org chart, business profile, agent bios. What is
// NEVER synced: conversations/messages, knowledge documents, tasks, company
// memory / agent learnings (chat-derived), usage, accounts or password
// hashes, invites. Those stay on each person's machine.

interface SharedProfile {
  ariaSharedProfile: 1;
  workspace: WorkspaceOrg | null;
  businessProfile: BusinessProfile;
  agents: AgentBio[];
}

function buildSharedProfile(): SharedProfile {
  const s = useStore.getState();
  return {
    ariaSharedProfile: 1,
    workspace: s.workspace,
    businessProfile: s.businessProfile,
    agents: s.agents.map(agentBio),
  };
}

/** Admin: publish the current company setup to the cloud workspace. */
export async function publishCompanySetup(): Promise<void> {
  const updatedAt = await publishSharedProfile(buildSharedProfile());
  const s = useStore.getState();
  useStore.setState({ settings: { ...s.settings, cloudProfileSyncedAt: updatedAt } });
}

/**
 * Member: pull the workspace's company setup and apply it when newer than
 * what this machine last applied. Quiet no-op offline or when unchanged.
 * Returns true when something new was applied.
 */
export async function pullCompanySetup(): Promise<boolean> {
  let remote: { data: any; updatedAt: string } | null;
  try {
    remote = await fetchSharedProfile();
  } catch {
    return false; // offline or signed out — try again next cycle
  }
  if (!remote || !remote.data || remote.data.ariaSharedProfile !== 1) return false;
  const s = useStore.getState();
  if (s.settings.cloudProfileSyncedAt && remote.updatedAt <= s.settings.cloudProfileSyncedAt) return false;
  const { agents } = mergeAgentBios(s.agents, remote.data.agents);
  useStore.setState({
    agents,
    workspace: remote.data.workspace ?? s.workspace,
    businessProfile: { ...s.businessProfile, ...(remote.data.businessProfile ?? {}) },
    settings: { ...s.settings, cloudProfileSyncedAt: remote.updatedAt },
  });
  return true;
}
