// Migration from the v1 single-file app's "ariaApp_v4" localStorage shape
// (ARIA V10–V20) into the v2 AppState. Non-destructive: anything we don't
// model is preserved under state._legacy so a backup round-trips losslessly.
import type {
  Agent,
  AppState,
  Conversation,
  Message,
  Project,
  RecurringTaskDef,
  Task,
  KnowledgeDoc,
  CompanyMemory,
} from "../types";
import {
  defaultState,
  defaultCompanyMemory,
  defaultBusinessProfile,
  defaultAdminRules,
} from "./defaults";

export function looksLikeV1(data: any): boolean {
  // v1 has "convs"/"msgs" and no schema marker; v2 always carries schema: 2.
  return !!data && typeof data === "object" && data.schema !== 2 && ("convs" in data || "msgs" in data || "apiKey" in data);
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function obj(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
}
function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
function num(v: unknown, d = 0): number {
  return typeof v === "number" && isFinite(v) ? v : d;
}

function migrateAgent(a: any): Agent {
  const wd = obj(a.workday);
  const mem = obj(a.memory);
  const level = a.autonomyLevel;
  return {
    id: str(a.id) || "a" + Math.random().toString(36).slice(2),
    name: str(a.name, "Agent"),
    emoji: str(a.emoji, "🤖"),
    role: str(a.role, "General"),
    personality: str(a.personality) as Agent["personality"],
    instructions: str(a.instructions),
    knowledge: str(a.knowledge),
    autoExec: !!a.autoExec,
    canWriteMemory: !!a.canWriteMemory,
    published: !!a.published,
    autonomyLevel: level === "auto" ? "auto" : level && level !== "off" ? "approval" : "off",
    proactiveMode: !!a.proactiveMode,
    expertise: arr<string>(a.expertise).map(String),
    stakeholders: arr<string>(a.stakeholders).map(String),
    goals: arr<any>(a.goals).map((g) => ({
      id: str(g.id) || "g" + Math.random().toString(36).slice(2),
      text: str(g.text ?? g.title),
      priority: g.priority === "high" || g.priority === "low" ? g.priority : "medium",
      metric: g.metric ? str(g.metric) : undefined,
      current: typeof g.current === "number" ? g.current : undefined,
      target: typeof g.target === "number" ? g.target : undefined,
      createdAt: num(g.createdAt, Date.now()),
      lastActivity: typeof g.lastActivity === "number" ? g.lastActivity : undefined,
    })),
    taskQueue: arr<any>(a.taskQueue).map((t) => ({
      id: str(t.id) || "t" + Math.random().toString(36).slice(2),
      title: str(t.title, "Task"),
      description: t.desc || t.description ? str(t.desc ?? t.description) : undefined,
      status:
        t.status === "in_progress" || t.status === "completed" || t.status === "blocked"
          ? t.status
          : "assigned",
      priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
      due: typeof t.due === "number" ? t.due : undefined,
      assignedAt: num(t.assignedAt, Date.now()),
      startedAt: typeof t.startedAt === "number" ? t.startedAt : undefined,
      completedAt: typeof t.completedAt === "number" ? t.completedAt : undefined,
      output: t.output ? str(t.output) : undefined,
      convId: t.convId ? str(t.convId) : undefined,
      blockers: arr<string>(t.blockers).map(String),
    })),
    memory: {
      learnings: arr<string>(mem.learnings).map(String),
      patterns: str(mem.patterns),
      gaps: arr<string>(mem.gaps).map(String),
    },
    workday: {
      startedAt: num(wd.startedAt, Date.now()),
      tasksCompleted: arr<any>(wd.tasksCompleted).map((x) =>
        typeof x === "string" ? { title: x, ts: 0 } : { title: str(x.title ?? x.text), ts: num(x.ts) }
      ),
      initiativesStarted: arr<any>(wd.initiativesStarted).map((x) =>
        typeof x === "string" ? { title: x, ts: 0 } : { title: str(x.title ?? x.text), ts: num(x.ts) }
      ),
      learningsDiscovered: arr<any>(wd.learningsDiscovered).map((x) =>
        typeof x === "string" ? { text: x, ts: 0 } : { text: str(x.text ?? x.title), ts: num(x.ts) }
      ),
      blockers: arr<any>(wd.blockers).map((x) =>
        typeof x === "string" ? { text: x, ts: 0 } : { text: str(x.text ?? x.title), ts: num(x.ts) }
      ),
    },
  };
}

function migrateCompanyMemory(cm: any): CompanyMemory {
  const base = defaultCompanyMemory();
  if (!cm || typeof cm !== "object") return base;
  const rec = (r: any) => ({
    id: str(r.id) || "r" + Math.random().toString(36).slice(2),
    name: str(r.name ?? r.title, "Untitled"),
    details: str(r.details ?? r.notes ?? r.desc),
    subRecords: arr<any>(r.subRecords ?? r.orders ?? r.items).map((s) => ({
      id: str(s.id) || "s" + Math.random().toString(36).slice(2),
      kind: str(s.kind ?? s.type, "note"),
      text: str(s.text ?? s.details ?? s.title),
      ts: num(s.ts ?? s.date, Date.now()),
    })),
    createdAt: num(r.createdAt ?? r.created, Date.now()),
    updatedAt: num(r.updatedAt ?? r.updated, Date.now()),
  });
  // V13 kept sub-collections (orders/tickets/interactions…) on the records themselves;
  // rec() folds whichever array it finds into subRecords.
  for (const key of ["customers", "products", "equipment", "processes", "notes"] as const) {
    (base as any)[key] = arr<any>(cm[key]).map(rec);
  }
  base.learningLog = arr<any>(cm.learningLog).map((e) => ({
    id: str(e.id) || "l" + Math.random().toString(36).slice(2),
    text: str(e.text),
    source: e.source === "correction" || e.source === "auto" ? e.source : "explicit",
    ts: num(e.ts, Date.now()),
    promoted: !!e.promoted,
  }));
  return base;
}

/**
 * Migrate a parsed ariaApp_v4 object. Returns the new state plus the secrets
 * that must be moved into the OS-encrypted store (they are stripped from state).
 */
export function migrateV1(d: any): { state: AppState; secrets: Record<string, string> } {
  const s = defaultState();
  const secrets: Record<string, string> = {};
  if (str(d.apiKey)) secrets.anthropicApiKey = d.apiKey;
  if (str(d.braveApiKey)) secrets.braveApiKey = d.braveApiKey;
  if (str(d.jinaApiKey)) secrets.jinaApiKey = d.jinaApiKey;

  s.model = str(d.model, s.model);
  if (s.model === "claude-opus-4-6") s.model = "claude-opus-4-8";
  s.maxTokens = num(d.maxTokens, s.maxTokens);
  s.darkMode = d.darkMode !== undefined ? !!d.darkMode : s.darkMode;
  s.showTimestamps = d.showTs !== undefined ? !!d.showTs : true;
  s.compactMode = !!d.compact;
  s.profile = {
    name: str(d.name),
    jobRole: str(d.jobRole),
    company: str(d.company),
    industry: str(d.industry),
  };

  const rawAgents = arr<any>(d.agents);
  if (rawAgents.length) s.agents = rawAgents.map(migrateAgent);
  s.activeAgentId = d.activeAgent ? str(d.activeAgent) : null;

  s.conversations = {};
  for (const [id, c] of Object.entries(obj(d.convs))) {
    const cv = obj(c);
    s.conversations[id] = {
      id,
      title: str(cv.title, "Conversation"),
      agentId: cv.aid ? str(cv.aid) : null,
      teamIds: arr<string>(cv.teamIds).length ? arr<string>(cv.teamIds).map(String) : undefined,
      projectId: cv.projId ? str(cv.projId) : undefined,
      folderId: cv.folderId ? str(cv.folderId) : undefined,
      pinned: !!cv.pinned,
      createdAt: num(cv.created ?? cv.createdAt, Date.now()),
      updatedAt: num(cv.updated ?? cv.updatedAt ?? cv.created, Date.now()),
      agentInitiated: !!cv.agentInitiated,
    } satisfies Conversation;
  }

  s.messages = {};
  for (const [convId, list] of Object.entries(obj(d.msgs))) {
    s.messages[convId] = arr<any>(list).map(
      (m): Message => ({
        id: str(m.id) || "m" + Math.random().toString(36).slice(2),
        role: m.role === "assistant" ? "assistant" : "user",
        content: str(m.content ?? m.text),
        ts: num(m.ts, Date.now()),
        agentId: m.aid || m.agentId ? str(m.aid ?? m.agentId) : undefined,
        rating: m.rating === 1 || m.rating === -1 ? m.rating : undefined,
        webSources: arr<any>(m.webSources).map((w) => ({ title: str(w.title, w.url), url: str(w.url) })),
        teamResponses: arr<any>(m.teamResponses).length
          ? arr<any>(m.teamResponses).map((t) => ({
              agentId: str(t.agentId ?? t.aid),
              content: str(t.content),
              error: t.error ? str(t.error) : undefined,
            }))
          : undefined,
      })
    );
  }
  s.activeConvId = d.activeConv ? str(d.activeConv) : null;

  s.projects = {};
  for (const [id, p] of Object.entries(obj(d.projects))) {
    const pv = obj(p);
    s.projects[id] = {
      id,
      name: str(pv.name, "Project"),
      emoji: str(pv.emoji, "📁"),
      color: str(pv.color, "#4f46e5"),
      description: str(pv.description ?? pv.desc),
      agentIds: arr<string>(pv.agentIds).map(String),
      notes: str(pv.notes),
      knowledge: str(pv.knowledge),
      createdAt: num(pv.created ?? pv.createdAt, Date.now()),
    } satisfies Project;
    // V13 stored per-project tasks on the project; fold into the global list.
    for (const t of arr<any>(pv.tasks)) {
      s.tasks.push({
        id: str(t.id) || "t" + Math.random().toString(36).slice(2),
        title: str(t.title ?? t.text, "Task"),
        done: !!t.done,
        createdAt: num(t.created ?? t.createdAt, Date.now()),
        completedAt: typeof t.completedAt === "number" ? t.completedAt : undefined,
        due: typeof t.due === "number" ? t.due : undefined,
        priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
        projectId: id,
      });
    }
  }

  for (const t of arr<any>(d.tasks)) {
    s.tasks.push({
      id: str(t.id) || "t" + Math.random().toString(36).slice(2),
      title: str(t.title ?? t.text, "Task"),
      done: !!t.done,
      createdAt: num(t.created ?? t.createdAt, Date.now()),
      completedAt: typeof t.completedAt === "number" ? t.completedAt : undefined,
      due: typeof t.due === "number" ? t.due : undefined,
      priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
      projectId: t.projId ? str(t.projId) : undefined,
      agentId: t.agentId ? str(t.agentId) : undefined,
      recurringId: t.recurringId ? str(t.recurringId) : undefined,
      autoExec: !!t.autoExec,
    } satisfies Task);
  }

  s.recurringTasks = arr<any>(d.recurringTasks).map(
    (r): RecurringTaskDef => ({
      id: str(r.id) || "r" + Math.random().toString(36).slice(2),
      title: str(r.title, "Recurring task"),
      freq: r.freq === "weekly" || r.freq === "monthly" || r.freq === "custom" ? r.freq : "daily",
      days: arr<number>(r.days).length ? arr<number>(r.days) : undefined,
      intervalDays: typeof r.intervalDays === "number" ? r.intervalDays : typeof r.interval === "number" ? r.interval : undefined,
      timeOfDay: r.timeOfDay ? str(r.timeOfDay) : undefined,
      lastFiredAt: typeof r.lastFired === "number" ? r.lastFired : typeof r.lastFiredAt === "number" ? r.lastFiredAt : undefined,
      nextDueAt: num(r.nextDue ?? r.nextDueAt, Date.now()),
      agentId: r.agentId ? str(r.agentId) : undefined,
      autoExec: !!r.autoExec,
      projectId: r.projId ? str(r.projId) : undefined,
    })
  );

  s.fileKnowledge = arr<any>(d.fileKnowledge).map(
    (k): KnowledgeDoc => ({
      id: str(k.id) || "k" + Math.random().toString(36).slice(2),
      name: str(k.name, "Document"),
      category: str(k.category, "General"),
      content: str(k.content ?? k.text),
      truncated: !!k.truncated,
      originalChars: num(k.originalChars, str(k.content ?? k.text).length),
      type:
        k.type === "pdf" || k.type === "docx" || k.type === "xlsx" || k.type === "image" || k.type === "web"
          ? k.type
          : "text",
      url: k.url ? str(k.url) : undefined,
      agentIds: arr<string>(k.agentIds).map(String),
      addedAt: num(k.added ?? k.addedAt, Date.now()),
    })
  );

  s.companyMemory = migrateCompanyMemory(d.companyMemory);

  const mem = obj(d.memory);
  s.businessProfile = {
    ...defaultBusinessProfile(),
    description: str(mem.description),
    products: str(mem.products),
    customers: str(mem.customers),
    keyAccounts: str(mem.keyAccounts),
    competitors: str(mem.competitors),
    advantages: str(mem.advantages),
    team: str(mem.team),
    initiatives: str(mem.initiatives),
    notes: str(mem.notes),
  };

  const ws = obj(d.workspace);
  if (d.workspace && (ws.org || ws.departments || ws.roles || ws.employees)) {
    const lines = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.map(String).filter(Boolean)
        : typeof v === "string"
          ? v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)
          : [];
    s.workspace = {
      org: str(ws.org),
      departments: lines(ws.departments),
      roles: lines(ws.roles),
      employees: arr<any>(ws.employees).map((e) =>
        typeof e === "string" ? { name: e } : { name: str(e.name), role: e.role ? str(e.role) : undefined }
      ),
    };
  }

  s.proactiveAlerts = arr<any>(d.proactiveAlerts).map((a) => ({
    id: str(a.id) || "al" + Math.random().toString(36).slice(2),
    agentId: str(a.agentId),
    type: "info" as const,
    title: str(a.title, "Alert"),
    body: str(a.body ?? a.text),
    ts: num(a.ts, Date.now()),
    read: !!a.read,
    convId: a.convId ? str(a.convId) : undefined,
  }));

  s.folders = {};
  for (const [id, f] of Object.entries(obj(d.folders))) {
    const fv = obj(f);
    s.folders[id] = { id, name: str(fv.name, "Folder"), createdAt: num(fv.created ?? fv.createdAt, Date.now()) };
  }

  s.artifacts = {};
  for (const [id, a] of Object.entries(obj(d.artifacts))) {
    const av = obj(a);
    s.artifacts[id] = {
      id,
      title: str(av.title, "Artifact"),
      type: str(av.type, "document"),
      content: str(av.content),
      projectId: av.projId ? str(av.projId) : undefined,
      convId: av.convId ? str(av.convId) : undefined,
      createdAt: num(av.created ?? av.createdAt, Date.now()),
    };
  }

  const rules = obj(d.adminRules);
  s.settings = {
    ...s.settings,
    adminPasswordHash: str(d.adminPassword), // already hashed by v1 (locally set)
    adminRules: { ...defaultAdminRules(), ...rules },
    webResearchMode: !!d.webResearchMode,
    autoSaveResearch: d.autoSaveResearch !== false,
    ttsEnabled: !!d.ttsEnabled,
    ttsVoice: str(d.ttsVoice),
    ttsRate: num(d.ttsRate, 1),
    onboarded: true, // migrated users have already been through setup
  };

  // Preserve everything we deliberately don't model (e.g. zoho, analytics).
  const legacy: Record<string, unknown> = {};
  for (const key of ["zoho", "analytics", "trainingMode", "trainingTopic"]) {
    if (d[key] !== undefined) legacy[key] = d[key];
  }
  if (Object.keys(legacy).length) s._legacy = legacy;

  return { state: s, secrets };
}
