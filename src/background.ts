import { parseChunk, splitDiffChunks } from "./core/diff";
import { JEV_ENDPOINT, JEV_MODEL, QUESTIONS, RUBRIC_VERSION, readAnswers, type JevAnswers, type JevState } from "./core/jev";
import { loadSettings } from "./core/settings";
import type { DiffFile, DiffResponse, Request, ScoreResponse, StatusResponse } from "./messages";

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handle(request).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: errorText(e), retryable: false }));
  return true; // keep the channel open for the async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// The API key lives in storage.local; keep that area out of reach of content scripts running on github.com.
// Chrome versions that only support access levels for storage.session reject the call; the key then stays readable there.
Promise.resolve()
  .then(() => chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }))
  .catch((e: unknown) => console.warn("GitFilter: could not restrict storage.local", e));

async function handle(request: Request): Promise<DiffResponse | ScoreResponse | StatusResponse | null> {
  switch (request.type) {
    case "diff:fetch":
      return fetchDiff(request.repo, request.number);
    case "jev:score":
      return score(request.state, request.digest, request.visibility);
    case "jev:status":
      return { hasKey: (await readApiKey()) !== "" };
    case "options:open":
      await chrome.runtime.openOptionsPage();
      return null;
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readApiKey(): Promise<string> {
  const { jevApiKey } = await chrome.storage.local.get("jevApiKey");
  return typeof jevApiKey === "string" ? jevApiKey.trim() : "";
}

// ---------------------------------------------------------------------------
// PR diff

/**
 * Fetches `/<repo>/pull/<n>.diff`. The first request omits cookies: success means the repository is public.
 * On 404 the worker retries with the user's GitHub cookies; that diff stays local (inventory) unless the
 * user allowed private repositories for Jev, which `score` enforces.
 */
async function fetchDiff(repo: string, number: number): Promise<DiffResponse> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number)) return { ok: false, error: "Invalid pull request" };
  const url = `https://github.com/${repo}/pull/${number}.diff`;

  const anonymous = await fetch(url, { credentials: "omit" });
  if (anonymous.ok) return parseDiffResponse(anonymous, "public");
  if (anonymous.status !== 404) return { ok: false, error: `GitHub returned ${anonymous.status} for the PR diff` };

  const authed = await fetch(url, { credentials: "include" });
  if (!authed.ok) return { ok: false, error: `GitHub returned ${authed.status} for the PR diff (are you signed in?)` };
  return parseDiffResponse(authed, "private");
}

async function parseDiffResponse(response: Response, visibility: "public" | "private"): Promise<DiffResponse> {
  const text = await response.text();
  if (text.trim() !== "" && !text.startsWith("diff --git ")) {
    return { ok: false, error: `GitHub did not return a diff (got ${response.headers.get("content-type") ?? "unknown content"}). The diff may be too large.` };
  }
  const files: DiffFile[] = [];
  for (const chunk of splitDiffChunks(text)) {
    const change = parseChunk(chunk);
    if (change) files.push({ ...change, digest: await sha256(chunk) });
  }
  return { ok: true, visibility, files };
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Jev

/** Max Jev requests in flight across all tabs. */
const MAX_IN_FLIGHT = 4;
const MAX_ATTEMPTS = 4;
let inFlight = 0;
const waiters: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlight >= MAX_IN_FLIGHT) {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push(resolve);
    await promise;
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

async function score(state: JevState, digest: string, visibility: "public" | "private"): Promise<ScoreResponse> {
  const settings = await loadSettings();
  if (!settings.jev.enabled || !settings.jev.consented) return { ok: false, error: "Jev is disabled in GitFilter options", retryable: false };
  if (visibility === "private" && !settings.jev.allowPrivateRepos) {
    return { ok: false, error: "Private repository: enable “Allow private repositories” in GitFilter options to send its diffs to TypeSafe.", retryable: false };
  }
  const apiKey = await readApiKey();
  if (apiKey === "") return { ok: false, error: "No TypeSafe API key configured", retryable: false };

  const cacheKey = await sha256(JSON.stringify({ v: RUBRIC_VERSION, model: JEV_MODEL, digest, state }));
  const hit = await cacheGet(cacheKey);
  if (hit) return { ok: true, answers: hit.answers, model: hit.model, cached: true };

  return withSlot(async () => {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(JEV_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS }),
        });
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) return { ok: false, error: `Network error: ${errorText(e)}`, retryable: true };
        await sleep(backoffMs(attempt, null));
        continue;
      }
      if (response.ok) {
        const { answers, model } = readAnswers(await response.json());
        // The answer is valid even if caching fails (e.g. storage quota); the next run just re-queries.
        await cachePut(cacheKey, { answers, model, t: Date.now() }).catch((e: unknown) => console.warn("GitFilter: cache write failed", e));
        return { ok: true, answers, model, cached: false };
      }
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }
      const detail = (await response.text()).slice(0, 300);
      const error = response.status === 401 ? "TypeSafe rejected the API key (401)" : `TypeSafe returned ${response.status}: ${detail}`;
      return { ok: false, error, retryable };
    }
  });
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(seconds)) return Math.min(30_000, seconds * 1000);
  return Math.min(16_000, 500 * 2 ** attempt) + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ---------------------------------------------------------------------------
// Answer cache (chrome.storage.local, bounded)

interface CacheEntry {
  answers: JevAnswers;
  model: string;
  t: number;
}
const CACHE_LIMIT = 3000;
/** Serializes read-modify-write cycles so concurrent scores do not drop each other's entries. */
let cacheWrites: Promise<void> = Promise.resolve();

async function cacheGet(key: string): Promise<CacheEntry | undefined> {
  const { jevCache } = await chrome.storage.local.get("jevCache");
  return (jevCache as Record<string, CacheEntry> | undefined)?.[key];
}

function cachePut(key: string, entry: CacheEntry): Promise<void> {
  const write = cacheWrites.then(async () => {
    const { jevCache } = await chrome.storage.local.get("jevCache");
    const cache = { ...((jevCache as Record<string, CacheEntry> | undefined) ?? {}), [key]: entry };
    const keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) {
      keys.sort((a, b) => cache[a]!.t - cache[b]!.t);
      for (const old of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache[old];
    }
    await chrome.storage.local.set({ jevCache: cache });
  });
  // A failed write (e.g. quota) must not block later writes.
  cacheWrites = write.catch(() => {});
  return write;
}
