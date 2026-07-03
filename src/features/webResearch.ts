// Optional live web research — OFF by default (Settings → Web Research).
// Ported from V13: keyless path reads a DuckDuckGo HTML SERP through the
// r.jina.ai reader and then fetches the top pages the same way. Brave/Jina
// API keys are optional upgrades, stored encrypted like the Anthropic key.
import { useStore } from "../store/store";
import type { WebSource } from "../types";

const TRIGGERS =
  /\b(latest|current|today|this (?:week|month|year)|recent|news|price|stock|weather|202[5-9]|who (?:is|won)|what happened|look up|search (?:for|the web)|find out)\b/i;
const URL_RE = /https?:\/\/[^\s<>"')]+/;

export function shouldWebSearch(text: string): boolean {
  return TRIGGERS.test(text) || URL_RE.test(text);
}

function extractQuery(text: string): string {
  return text.replace(/[\n\r]+/g, " ").replace(/[?!.]+$/, "").trim().slice(0, 160);
}

async function readerFetch(url: string): Promise<string | null> {
  const res = await window.aria.net.fetchText("https://r.jina.ai/" + url, {
    headers: { "x-return-format": "text" },
  });
  return res.ok && res.text ? res.text : null;
}

interface SearchHit {
  title: string;
  url: string;
}

/** Keyless search: DuckDuckGo HTML SERP read through r.jina.ai. */
async function ddgReaderSearch(query: string, count = 4): Promise<SearchHit[]> {
  const raw = await readerFetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
  if (!raw) return [];
  const hits: SearchHit[] = [];
  const re = /duckduckgo\.com\/l\/\?uddg=([^&\s")]+)[^\n]*/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) && hits.length < count) {
    try {
      const url = decodeURIComponent(m[1]);
      const host = new URL(url).hostname;
      if (seen.has(host) || /duckduckgo\.com/.test(host)) continue;
      seen.add(host);
      hits.push({ title: host, url });
    } catch {
      /* skip malformed */
    }
  }
  return hits;
}

async function braveSearch(query: string, count = 4): Promise<SearchHit[]> {
  // The stored Brave key is injected by the main process; renderer never sees it.
  const res = await window.aria.net.fetchText(
    "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + `&count=${count}`,
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok || !res.text) return [];
  try {
    const data = JSON.parse(res.text);
    return (data.web?.results ?? []).slice(0, count).map((r: any) => ({ title: r.title, url: r.url }));
  } catch {
    return [];
  }
}

export interface ResearchResult {
  prompt: string;
  sources: WebSource[];
}

/**
 * Raw research pass: search (or read a direct URL) and return the fetched
 * page context + sources. Null when nothing usable came back.
 */
export async function runWebResearch(userText: string): Promise<{ context: string; sources: WebSource[] } | null> {
  const directUrl = userText.match(URL_RE)?.[0];
  const sources: WebSource[] = [];
  const chunks: string[] = [];

  try {
    if (directUrl) {
      const page = await readerFetch(directUrl);
      if (page) {
        sources.push({ title: new URL(directUrl).hostname, url: directUrl });
        chunks.push(`SOURCE: ${directUrl}\n${page.slice(0, 8000)}`);
      }
    } else {
      const query = extractQuery(userText);
      let hits: SearchHit[] = [];
      // Brave first when a key is stored (main injects it); reader-SERP is the keyless default.
      if (await window.aria.secrets.has("braveApiKey")) hits = await braveSearch(query);
      if (!hits.length) hits = await ddgReaderSearch(query);
      const pages = await Promise.all(hits.slice(0, 3).map((h) => readerFetch(h.url)));
      hits.forEach((h, i) => {
        const page = pages[i];
        if (page) {
          sources.push({ title: h.title, url: h.url });
          chunks.push(`SOURCE ${i + 1}: ${h.url}\n${page.slice(0, 6000)}`);
        }
      });
    }
  } catch (e) {
    console.warn("web research failed", e);
  }

  if (!chunks.length) return null;
  return { context: chunks.join("\n\n"), sources };
}

/**
 * If web research mode is on and the message needs live info, search + read
 * pages and return an augmented API prompt plus source badges. Returns null
 * to send the message unmodified.
 */
export async function maybeRunWebResearch(userText: string, force = false): Promise<ResearchResult | null> {
  const s = useStore.getState();
  if (!force && !s.settings.webResearchMode) return null;

  const directUrl = userText.match(URL_RE)?.[0];
  if (!force && !directUrl && !shouldWebSearch(userText)) return null;

  s.toast("Researching the web…", "info");
  const r = await runWebResearch(userText);

  if (!r) {
    s.toast("Web research found nothing usable — answering from model knowledge.", "info");
    return null;
  }
  const { context, sources } = r;

  const prompt =
    `${userText}\n\n---\nLIVE WEB RESEARCH (fetched just now — treat as current ground truth, cite sources by number when used):\n\n` +
    context +
    `\n---\nAnswer the user's message using this research where relevant. Note anything the sources disagree on.`;
  return { prompt, sources };
}

export { braveSearch };
