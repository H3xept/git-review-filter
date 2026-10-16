import { JEV_ENDPOINT, JEV_MODEL, ROLE_LABELS, ROLES, type Role } from "../core/jev";
import { parseRules, PRESET_NAMES, PRESETS } from "../core/rules";
import { loadSettings, saveSettings, type Settings } from "../core/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const globalRules = $<HTMLTextAreaElement>("globalRules");
const jevEnabled = $<HTMLInputElement>("jevEnabled");
const jevConsented = $<HTMLInputElement>("jevConsented");
const jevAllowPrivate = $<HTMLInputElement>("jevAllowPrivate");
const jevApiKey = $<HTMLInputElement>("jevApiKey");
const jevThreshold = $<HTMLInputElement>("jevThreshold");
const jevThresholdValue = $<HTMLOutputElement>("jevThresholdValue");
const saveError = $("saveError");

let settings: Settings = await loadSettings();

async function persist(change: (s: Settings) => Settings): Promise<void> {
  const next = change(settings);
  try {
    await saveSettings(next);
    settings = next;
    saveError.textContent = "";
  } catch (e) {
    saveError.textContent = e instanceof Error ? e.message : String(e);
  }
}

// Presets
const presetBox = $("presets");
for (const name of PRESET_NAMES) {
  const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: settings.presets.includes(name) });
  input.addEventListener("change", () =>
    persist((s) => ({ ...s, presets: input.checked ? [...s.presets.filter((p) => p !== name), name] : s.presets.filter((p) => p !== name) })),
  );
  const label = document.createElement("label");
  label.className = "preset";
  const code = document.createElement("code");
  code.textContent = PRESETS[name].join("  ");
  label.append(input, ` ${name} `, code);
  presetBox.append(label);
}

// Global rules: validate on input, save when valid.
const globalStatus = $("globalRulesStatus");
globalRules.value = settings.globalRules;
let rulesTimer: number | undefined;
globalRules.addEventListener("input", () => {
  clearTimeout(rulesTimer);
  rulesTimer = window.setTimeout(async () => {
    const { errors } = parseRules(globalRules.value, "global");
    if (errors.length > 0) {
      globalStatus.className = "status error";
      globalStatus.textContent = errors.map((e) => `Line ${e.lineNumber}: ${e.message}`).join("\n");
      return;
    }
    await persist((s) => ({ ...s, globalRules: globalRules.value }));
    globalStatus.className = "status";
    globalStatus.textContent = saveError.textContent ? "" : "Saved";
  }, 400);
});

// Repository rules (read-only list with delete)
async function renderRepoRules(): Promise<void> {
  const all = await chrome.storage.sync.get(null);
  const list = $("repoRules");
  list.replaceChildren();
  const repos = Object.keys(all).filter((k) => k.startsWith("repo:")).sort();
  if (repos.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "None yet.";
    list.append(li);
  }
  for (const key of repos) {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = key.slice("repo:".length);
    const pre = document.createElement("pre");
    pre.textContent = String(all[key]);
    const del = Object.assign(document.createElement("button"), { type: "button", textContent: "Delete" });
    del.addEventListener("click", async () => {
      await chrome.storage.sync.remove(key);
      await renderRepoRules();
    });
    li.append(name, " ", del, pre);
    list.append(li);
  }
}
await renderRepoRules();

// Jev
function renderJevEnabled(): void {
  $<HTMLFieldSetElement>("jevFields").disabled = !jevEnabled.checked;
}
jevEnabled.checked = settings.jev.enabled;
jevConsented.checked = settings.jev.consented;
jevAllowPrivate.checked = settings.jev.allowPrivateRepos;
renderJevEnabled();
jevEnabled.addEventListener("change", () => {
  renderJevEnabled();
  void persist((s) => ({ ...s, jev: { ...s.jev, enabled: jevEnabled.checked } }));
});
jevConsented.addEventListener("change", () => void persist((s) => ({ ...s, jev: { ...s.jev, consented: jevConsented.checked } })));
jevAllowPrivate.addEventListener("change", () => void persist((s) => ({ ...s, jev: { ...s.jev, allowPrivateRepos: jevAllowPrivate.checked } })));

const { jevApiKey: storedKey } = await chrome.storage.local.get("jevApiKey");
jevApiKey.value = typeof storedKey === "string" ? storedKey : "";
jevApiKey.addEventListener("change", () => void chrome.storage.local.set({ jevApiKey: jevApiKey.value.trim() }));

const testStatus = $("jevTestStatus");
$("jevTest").addEventListener("click", async () => {
  testStatus.className = "status";
  testStatus.textContent = "Testing…";
  try {
    // Contains no repository data, so it does not need the consent checkbox.
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${jevApiKey.value.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state: "GitFilter key check", questions: { ok: { type: "noul", instructions: "The state is a short text." } } }),
    });
    if (res.ok) {
      const body = (await res.json()) as { model?: string };
      testStatus.textContent = `Key works (${body.model ?? JEV_MODEL}).`;
    } else {
      testStatus.className = "status error";
      testStatus.textContent = res.status === 401 ? "TypeSafe rejected this key (401)." : `TypeSafe returned ${res.status}.`;
    }
  } catch (e) {
    testStatus.className = "status error";
    testStatus.textContent = `Request failed: ${e instanceof Error ? e.message : String(e)}`;
  }
});

jevThreshold.value = String(settings.jev.attentionThreshold);
jevThresholdValue.textContent = Number(jevThreshold.value).toFixed(2);
jevThreshold.addEventListener("input", () => (jevThresholdValue.textContent = Number(jevThreshold.value).toFixed(2)));
jevThreshold.addEventListener("change", () => void persist((s) => ({ ...s, jev: { ...s.jev, attentionThreshold: Number(jevThreshold.value) } })));

const roleBox = $("jevRoles");
const OPTIONAL_ROLES: Role[] = (Object.keys(ROLES) as Role[]).filter((r) => !["application_logic", "dependency_lockfile", "generated_or_vendored", "assets"].includes(r));
for (const role of OPTIONAL_ROLES) {
  const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: settings.jev.lowInterestRoles.includes(role) });
  input.addEventListener("change", () =>
    persist((s) => ({
      ...s,
      jev: { ...s.jev, lowInterestRoles: input.checked ? [...s.jev.lowInterestRoles.filter((r) => r !== role), role] : s.jev.lowInterestRoles.filter((r) => r !== role) },
    })),
  );
  const label = document.createElement("label");
  label.className = "check";
  label.append(input, ` ${ROLE_LABELS[role]}`);
  roleBox.append(label);
}
