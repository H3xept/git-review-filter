import { PRESET_NAMES, type PresetName } from "./rules";
import { DEFAULT_SUGGESTION_SETTINGS, ROLES, type Role } from "./jev";

/**
 * Storage layout (chrome.storage.sync limits: 8 KB per item, 100 KB total):
 *   sync  "settings"          Settings (small, bounded)
 *   sync  "repo:<owner>/<r>"  per-repository rule text
 *   local "jevApiKey"         TypeSafe API key (never synced; read only by the service worker)
 *   local "jevCache"          cached Jev answers
 */
export interface Settings {
  presets: PresetName[];
  globalRules: string;
  jev: {
    enabled: boolean;
    /** The user acknowledged that file paths and diff excerpts are sent to TypeSafe. */
    consented: boolean;
    allowPrivateRepos: boolean;
    attentionThreshold: number;
    lowInterestRoles: Role[];
  };
}

export const DEFAULT_SETTINGS: Settings = {
  presets: [],
  globalRules: "",
  jev: {
    enabled: false,
    consented: false,
    allowPrivateRepos: false,
    attentionThreshold: DEFAULT_SUGGESTION_SETTINGS.attentionThreshold,
    lowInterestRoles: [],
  },
};

/** chrome.storage.sync.QUOTA_BYTES_PER_ITEM */
export const SYNC_ITEM_QUOTA = 8192;

/** Fills missing or invalid fields from defaults so older or hand-edited data still loads. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Settings> & { jev?: Partial<Settings["jev"]> };
  const jev: Partial<Settings["jev"]> = r.jev ?? {};
  const threshold = Number(jev.attentionThreshold);
  return {
    presets: Array.isArray(r.presets) ? r.presets.filter((p): p is PresetName => PRESET_NAMES.includes(p)) : [],
    globalRules: typeof r.globalRules === "string" ? r.globalRules : "",
    jev: {
      enabled: jev.enabled === true,
      consented: jev.consented === true,
      allowPrivateRepos: jev.allowPrivateRepos === true,
      attentionThreshold: Number.isFinite(threshold) ? Math.min(3, Math.max(0, threshold)) : DEFAULT_SETTINGS.jev.attentionThreshold,
      lowInterestRoles: Array.isArray(jev.lowInterestRoles) ? jev.lowInterestRoles.filter((x): x is Role => x in ROLES) : [],
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.sync.get("settings");
  return normalizeSettings(settings);
}

/** Byte size as chrome.storage.sync counts it: key length + JSON length. */
export function syncItemBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const size = syncItemBytes("settings", settings);
  if (size > SYNC_ITEM_QUOTA) throw new Error(`Settings are ${size} bytes; Chrome sync allows ${SYNC_ITEM_QUOTA} per item. Move some global rules into repository rules.`);
  await chrome.storage.sync.set({ settings });
}

export const repoKey = (repo: string) => `repo:${repo}`;

export async function loadRepoRules(repo: string): Promise<string> {
  const key = repoKey(repo);
  const value = (await chrome.storage.sync.get(key))[key];
  return typeof value === "string" ? value : "";
}

export async function saveRepoRules(repo: string, text: string): Promise<void> {
  const key = repoKey(repo);
  if (text.trim() === "") {
    await chrome.storage.sync.remove(key);
    return;
  }
  const size = syncItemBytes(key, text);
  if (size > SYNC_ITEM_QUOTA) throw new Error(`Rules for ${repo} are ${size} bytes; Chrome sync allows ${SYNC_ITEM_QUOTA} per item.`);
  await chrome.storage.sync.set({ [key]: text });
}
