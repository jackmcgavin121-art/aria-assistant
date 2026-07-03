# ARIA — AI Business Assistant

Installable Windows 11 desktop app: chat with a roster of specialist AI agents, assign
them real tasks they complete via the Anthropic API, organise work into projects, keep a
local knowledge base / mini-CRM, and get proactive alerts. Local-first: all data lives on
this machine, you bring your own Anthropic API key (stored encrypted via Windows DPAPI).

## Stack

- React 19 + TypeScript + Vite (`src/`), Zustand store persisted to disk
- Electron shell (`electron/main.cjs`, `electron/preload.cjs`) — owns all network I/O
  (Anthropic streaming + allowlisted fetch proxy) and on-disk persistence in
  `%APPDATA%\aria-assistant\aria-state.json`
- pdf.js / mammoth / SheetJS for document ingestion

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + Electron together (hot reload) |
| `npm run dev:renderer` | Renderer only, in a browser (uses a dev-only bridge shim) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Production build + Windows installer (NSIS + portable) into `dist/` |
| `npm start` | Launch Electron against the last build / dev server |

## Data & migration

- State schema v2; backups export/import as a single JSON from Settings → Data.
- Old single-file ARIA (V10–V20, `localStorage["ariaApp_v4"]`) data migrates automatically
  on first run (an automatic backup is written first), or via Settings → Data → Import backup.
- API keys (Anthropic / Brave / Jina) never live in state or backups — they're in
  `aria-secrets.json`, encrypted with `safeStorage` (DPAPI).

## v2.1 improvements round

22 UI/workflow upgrades: syntax-highlighted code blocks with copy buttons, AI-generated
chat titles, edit-&-resend, resizable/collapsible panels (Ctrl+B), interface-size slider,
command palette actions (Ctrl+K) + recent-conversation switcher (Ctrl+P), desktop
notifications, system tray with close-to-tray, slash commands (`/task /remember /research
/artifact`), save-reply-to-knowledge, revision chips on agent deliverables, drag-and-drop
files, Whisper dictation (optional OpenAI key), prompt caching on large system prompts,
relevance-ranked knowledge retrieval, tool-use-based autonomy decisions, per-agent
recurring-work scheduling, summarize-&-continue, email-out (mailto), agent handoffs, and
a real-metrics performance dashboard.

**Deliberately skipped:** auto-updates (needs a public release feed — set up a GitHub repo
with releases + electron-updater when ready), SQLite storage (JSON store is fine at current
data sizes; revisit if state grows past tens of MB), and code signing (requires purchasing
an OV/EV certificate — until then SmartScreen shows "More info → Run anyway").

## Legacy

`legacy/` holds the previous single-file app (V8/V9 HTML + old Electron entry). Reference
only — the current app does not load it. Newer single-file versions live in `Downloads/ARIA_V*.html`.
