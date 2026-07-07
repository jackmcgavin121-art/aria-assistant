// Organisation profile: a portable file with the company setup — workspace
// org chart, business profile, agent roster (definitions/bios, no runtime
// state), and login accounts (password hashes only). Exported by an admin,
// imported on each staff machine so everyone runs the same workplace setup.
// Conversations, tasks, and knowledge documents are NOT included — those
// stay in full backups.
import { useStore } from "../store/store";
import type { Account, Agent, BusinessProfile, WorkspaceOrg } from "../types";
import { uid } from "../lib/util";

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

  const incoming: AgentBio[] = Array.isArray(data.agents) ? data.agents.filter((a: any) => a && a.name) : [];
  let updated = 0;
  const agents: Agent[] = s.agents.map((a) => {
    const match = incoming.find((b) => b.name.toLowerCase() === a.name.toLowerCase());
    if (!match) return a;
    updated++;
    return { ...a, ...match };
  });
  const fresh = incoming.filter((b) => !s.agents.some((a) => a.name.toLowerCase() === b.name.toLowerCase()));
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

  const accounts: Account[] = Array.isArray(data.accounts)
    ? data.accounts.filter((a: any) => a && a.email && a.passHash && a.salt)
    : [];

  useStore.setState({
    agents,
    workspace: data.workspace ?? s.workspace,
    businessProfile: { ...s.businessProfile, ...(data.businessProfile ?? {}) },
    ...(accounts.length ? { accounts } : {}),
    settings: {
      ...s.settings,
      // Only flip the login gate on when the file actually carries accounts.
      authEnabled: accounts.length ? !!data.authEnabled : s.settings.authEnabled,
    },
  });
  return { agentsUpdated: updated, agentsAdded: fresh.length, accounts: accounts.length };
}
