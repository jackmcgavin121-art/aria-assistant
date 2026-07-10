// Central data model. Everything here must stay plain-JSON-serializable —
// the whole AppState is exported/imported as a single backup file.

export type ViewId =
  | "home"
  | "chat"
  | "agents"
  | "knowledge"
  | "projects"
  | "tasks"
  | "agenthub"
  | "workload";

export type PersonalityId =
  | "technical"
  | "friendly"
  | "commercial"
  | "analytical"
  | "creative"
  | "formal"
  | "precise"
  | "";

export interface Profile {
  name: string;
  jobRole: string;
  company: string;
  industry: string;
}

export interface Goal {
  id: string;
  text: string;
  priority: "low" | "medium" | "high";
  metric?: string;
  current?: number;
  target?: number;
  createdAt: number;
  lastActivity?: number;
}

export type AgentTaskStatus = "assigned" | "in_progress" | "completed" | "blocked";

export interface AgentTask {
  id: string;
  title: string;
  description?: string;
  status: AgentTaskStatus;
  priority: "low" | "medium" | "high";
  due?: number;
  assignedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Characters streamed so far while running — drives the honest progress bar. */
  streamedChars?: number;
  output?: string;
  convId?: string;
  blockers?: string[];
  autoDiscovered?: boolean;
  /** Live web sources the agent consulted while executing. */
  webSources?: WebSource[];
}

export interface AgentMemory {
  learnings: string[];
  patterns: string;
  gaps: string[];
}

export interface AgentWorkday {
  startedAt: number;
  tasksCompleted: { title: string; ts: number }[];
  initiativesStarted: { title: string; ts: number }[];
  learningsDiscovered: { text: string; ts: number }[];
  blockers: { text: string; ts: number }[];
}

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  personality: PersonalityId;
  instructions: string;
  knowledge: string;
  autoExec: boolean;
  canWriteMemory: boolean;
  published: boolean;
  /** "off" = plain assistant; "approval" = autonomy loop raises alerts before acting; "auto" = executes low-risk plans. */
  autonomyLevel: "off" | "approval" | "auto";
  proactiveMode: boolean;
  expertise: string[];
  stakeholders: string[];
  goals: Goal[];
  taskQueue: AgentTask[];
  memory: AgentMemory;
  workday: AgentWorkday;
  /** Optional model override; falls back to the global default. */
  model?: string;
  /** Last time the background autonomy scheduler ran a cycle for this agent. */
  lastAutonomyRunAt?: number;
  /** Last time an automatic weekly report was generated for this agent. */
  lastWeeklyReportAt?: number;
}

export interface WebSource {
  title: string;
  url: string;
}

export interface Attachment {
  name: string;
  kind: "pdf" | "docx" | "xlsx" | "image" | "text";
  chars: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  agentId?: string;
  model?: string;
  rating?: 1 | -1;
  stopped?: boolean;
  webSources?: WebSource[];
  attachments?: Attachment[];
  /** Parsed document text kept with the message so edit/regenerate re-sends it. */
  attachmentText?: string;
  /** Attached images (kept only when small enough to persist sanely). */
  images?: { mediaType: string; base64: string }[];
  /** Real token usage reported by the API for this reply. */
  tokens?: { in: number; out: number };
  /** Team mode: parallel responses keyed by agent id. */
  teamResponses?: { agentId: string; content: string; error?: string }[];
}

export interface Conversation {
  id: string;
  title: string;
  agentId: string | null;
  teamIds?: string[];
  projectId?: string;
  folderId?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Conversations an agent started itself (proactive/autonomy). */
  agentInitiated?: boolean;
  /** Soft delete: set when moved to trash; purged after 30 days. */
  deletedAt?: number;
}

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  agentIds: string[];
  notes: string;
  knowledge: string;
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  completedAt?: number;
  due?: number;
  priority: "low" | "medium" | "high";
  projectId?: string;
  agentId?: string;
  recurringId?: string;
  /** When set with agentId, assignment also queues real agent execution. */
  autoExec?: boolean;
}

export type RecurFreq = "daily" | "weekly" | "monthly" | "custom";

export interface RecurringTaskDef {
  id: string;
  title: string;
  freq: RecurFreq;
  /** weekly: days of week 0-6; custom: every N days. */
  days?: number[];
  intervalDays?: number;
  timeOfDay?: string;
  lastFiredAt?: number;
  nextDueAt: number;
  agentId?: string;
  autoExec?: boolean;
  projectId?: string;
}

export interface KnowledgeDoc {
  id: string;
  name: string;
  category: string;
  content: string;
  truncated: boolean;
  originalChars: number;
  type: "pdf" | "docx" | "xlsx" | "image" | "text" | "web";
  url?: string;
  agentIds: string[];
  addedAt: number;
}

export interface SubRecord {
  id: string;
  kind: string; // order | ticket | interaction | fault | service | revision | step
  text: string;
  ts: number;
}

export interface MemoryRecord {
  id: string;
  name: string;
  details: string;
  subRecords: SubRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface LearningLogEntry {
  id: string;
  text: string;
  source: "explicit" | "correction" | "auto";
  ts: number;
  promoted: boolean;
}

export interface CompanyMemory {
  customers: MemoryRecord[];
  products: MemoryRecord[];
  equipment: MemoryRecord[];
  processes: MemoryRecord[];
  notes: MemoryRecord[];
  learningLog: LearningLogEntry[];
}

/** Free-text business profile injected into every system prompt (V13 "memory"). */
export interface BusinessProfile {
  description: string;
  products: string;
  customers: string;
  keyAccounts: string;
  competitors: string;
  advantages: string;
  team: string;
  initiatives: string;
  notes: string;
}

export interface WorkspaceOrg {
  org: string;
  departments: string[];
  roles: string[];
  employees: { name: string; role?: string }[];
}

/** Local login account. Passwords are stored as salted PBKDF2 hashes, never plaintext. */
export interface Account {
  id: string;
  email: string;
  name?: string;
  role: "admin" | "staff";
  passHash: string;
  salt: string;
  createdAt: number;
}

/**
 * Invite code an admin hands to a staff member so they can create their own
 * account (and pick their own password) on first sign-in. Single-use, expires.
 * Travels inside the organisation profile so staff PCs can redeem it.
 */
export interface Invite {
  id: string;
  code: string; // short human-typable code, e.g. "KRTX-29MF"
  role: "admin" | "staff";
  /** Optional label so the admin remembers who it's for. */
  forName?: string;
  createdAt: number;
  expiresAt: number;
  usedByEmail?: string;
  usedAt?: number;
}

export interface ProactiveAlert {
  id: string;
  agentId: string;
  type: "goal_critical" | "goal_stalled" | "task_overdue" | "task_completed" | "approval_needed" | "info";
  title: string;
  body: string;
  ts: number;
  read: boolean;
  convId?: string;
  /** approval_needed: the proposed action awaiting user sign-off. */
  proposedAction?: { taskTitle: string; taskDescription: string };
}

export interface AdminRules {
  enabled: boolean;
  noPersonalAdvice: boolean;
  formalOnly: boolean;
  noOffTopic: boolean;
  offTopicBlock: string;
  maxDailyMsgs: number;
  customRule: string;
}

export interface Artifact {
  id: string;
  title: string;
  type: string;
  content: string;
  projectId?: string;
  convId?: string;
  createdAt: number;
}

export interface Settings {
  adminPasswordHash: string; // locally set, never shipped — empty = admin mode not configured
  adminRules: AdminRules;
  webResearchMode: boolean;
  autoSaveResearch: boolean;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsRate: number;
  onboarded: boolean;
  maxAgentTasks: number; // capacity denominator for workload view
  fontScale: number; // 0.85–1.3, multiplies the base font size
  sidebarCollapsed: boolean;
  convListWidth: number; // px
  closeToTray: boolean;
  notificationsEnabled: boolean;
  /** Last app version the user has seen — drives the "what's new" note after updates. */
  lastSeenVersion?: string;
  /** When true, ARIA shows a login screen before the app opens (accounts in AppState.accounts). */
  authEnabled?: boolean;
  /** First-run chooser was skipped ("just me on this PC") — don't show it again. */
  authSetupDismissed?: boolean;
  /** Last email signed in on this machine — pre-filled on the login screen (never the password). */
  lastLoginEmail?: string;
  /** Auto sign-out after this many minutes without keyboard/mouse activity. 0/undefined = off. */
  idleLogoutMinutes?: number;
  /** Salted hash of the admin recovery key (shown once at workspace setup, never stored in plain). */
  recoveryKey?: { salt: string; hash: string; createdAt: number };
  /** Failed-login throttle for this machine: escalating lockout after repeated wrong passwords. */
  loginThrottle?: { fails: number; lockedUntil: number };
  /** Cloud workspace (Supabase project) this install is connected to. The anon key is publishable by design. */
  cloud?: CloudConfig;
  /** Last entitlement fetched from the cloud — cached so offline never bricks the app (14-day grace). */
  cloudEntitlement?: CloudEntitlement;
  /** Server updated_at of the shared company setup this machine last applied/published. */
  cloudProfileSyncedAt?: string;
}

/** Connection to a Supabase project acting as the workspace directory + licence authority. */
export interface CloudConfig {
  url: string; // https://<ref>.supabase.co
  anonKey: string;
  orgId?: string;
  orgName?: string;
}

export interface CloudEntitlement {
  plan: string; // "free" | "starter" | "business" …
  status: string; // "active" | "past_due" | "cancelled"
  seatLimit: number;
  seatsUsed: number;
  /** Last successful server check — the app works offline for 14 days from here. */
  checkedAt: number;
}

/** Real token usage accumulated from API responses: month (YYYY-MM) → model → totals. */
export interface UsageBucket {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}
export type UsageLog = Record<string, Record<string, UsageBucket>>;

export interface AppState {
  schema: 2;
  model: string;
  maxTokens: number;
  darkMode: boolean;
  showTimestamps: boolean;
  compactMode: boolean;
  profile: Profile;
  agents: Agent[];
  activeAgentId: string | null;
  activeConvId: string | null;
  conversations: Record<string, Conversation>;
  messages: Record<string, Message[]>;
  projects: Record<string, Project>;
  tasks: Task[];
  recurringTasks: RecurringTaskDef[];
  fileKnowledge: KnowledgeDoc[];
  companyMemory: CompanyMemory;
  businessProfile: BusinessProfile;
  workspace: WorkspaceOrg | null;
  proactiveAlerts: ProactiveAlert[];
  folders: Record<string, Folder>;
  artifacts: Record<string, Artifact>;
  settings: Settings;
  usage: UsageLog;
  accounts: Account[];
  invites: Invite[];
  /** Untouched fields carried over from a v1 (ariaApp_v4) import so nothing is lost. */
  _legacy?: Record<string, unknown>;
}
