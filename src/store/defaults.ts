import type { AppState, CompanyMemory, BusinessProfile, Settings, AdminRules } from "../types";
import { DEFAULT_MODEL, defaultAgents } from "../data/presets";

export function defaultAdminRules(): AdminRules {
  return {
    enabled: false,
    noPersonalAdvice: false,
    formalOnly: false,
    noOffTopic: false,
    offTopicBlock: "",
    maxDailyMsgs: 0,
    customRule: "",
  };
}

export function defaultCompanyMemory(): CompanyMemory {
  return { customers: [], products: [], equipment: [], processes: [], notes: [], learningLog: [] };
}

export function defaultBusinessProfile(): BusinessProfile {
  return {
    description: "",
    products: "",
    customers: "",
    keyAccounts: "",
    competitors: "",
    advantages: "",
    team: "",
    initiatives: "",
    notes: "",
  };
}

export function defaultSettings(): Settings {
  return {
    adminPasswordHash: "",
    adminRules: defaultAdminRules(),
    webResearchMode: false,
    autoSaveResearch: true,
    ttsEnabled: false,
    ttsVoice: "",
    ttsRate: 1,
    onboarded: false,
    maxAgentTasks: 5,
    fontScale: 1,
    sidebarCollapsed: false,
    convListWidth: 260,
    closeToTray: false,
    notificationsEnabled: true,
  };
}

export function defaultState(): AppState {
  return {
    schema: 2,
    model: DEFAULT_MODEL,
    maxTokens: 2048,
    darkMode: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    showTimestamps: true,
    compactMode: false,
    profile: { name: "", jobRole: "", company: "", industry: "" },
    agents: defaultAgents(),
    activeAgentId: null,
    activeConvId: null,
    conversations: {},
    messages: {},
    projects: {},
    tasks: [],
    recurringTasks: [],
    fileKnowledge: [],
    companyMemory: defaultCompanyMemory(),
    businessProfile: defaultBusinessProfile(),
    workspace: null,
    proactiveAlerts: [],
    folders: {},
    artifacts: {},
    settings: defaultSettings(),
    usage: {},
  };
}

export const PROJECT_COLORS = [
  "#4f46e5", "#0891b2", "#15a34a", "#b45309", "#dc2626", "#7c3aed", "#db2777", "#475569",
];
