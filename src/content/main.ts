import { classify, buildState, type Classification, type JevAnswers } from "../core/jev";
import { computeVisibility, exactPathRule, parseRules, presetRules, type Decision, type PresetName, type Rule, type RuleError } from "../core/rules";
import { loadRepoRules, loadSettings, normalizeSettings, repoKey, saveRepoRules, saveSettings, DEFAULT_SETTINGS, type Settings } from "../core/settings";
import { send, type DiffFile, type DiffResponse } from "../messages";
import { anchorForPath, HIDE_STYLE, parsePrFilesPath, prTitleFromDocumentTitle, scanFiles, scanTree, setHidden, syncDirectoryRows, type PrRef } from "./github";
import { INSIGHT_CSS, removeInsights, syncInsight, type FileInsight, type InsightActions } from "./insights";
import { Panel, type JevView } from "./panel";

/** Files sent to Jev per click; protects against accidental spend on huge PRs. */
const MAX_FILES_PER_RUN = 300;
const JEV_CONCURRENCY = 4;

/** `ok: null` while the PR diff is loading. */
type DiffState = DiffResponse | { ok: null };
type JevResult = { kind: "answers"; answers: JevAnswers; model: string } | { kind: "binary" };
/** Binary files are low interest without asking Jev. */
const BINARY_FILE: Classification = { low: true, reason: "binary file", attention: 0, role: "assets", roleProbability: 1 };

/** One activation of the extension on one PR files page. Torn down on navigation away. */
class Session {
  readonly key: string;
  private alive = true;
  private readonly style: HTMLStyleElement;
  private readonly panel: Panel;
  private readonly observer: MutationObserver;

  private settings: Settings = DEFAULT_SETTINGS;
  private repoRules = "";
  private rules: Rule[] = [];
  private ruleErrors: RuleError[] = [];

  /** Every known path, in PR order once the diff loads; DOM discoveries are appended. */
  private readonly paths = new Set<string>();
  private readonly anchorToPath = new Map<string, string>();
  private diff: DiffState = { ok: null };
  private decisions = new Map<string, Decision>();

  private query = "";
  private readonly hiddenExtensions = new Set<string>();
  private readonly overrides = new Map<string, boolean>();
  private readonly accepted = new Map<string, string>();

  private jevStatus: JevView["status"] = "idle";
  private jevCompleted = 0;
  private jevTotal = 0;
  private jevErrors: string[] = [];
  private jevHasKey = false;
  private readonly jevResults = new Map<string, JevResult>();
  private readonly dismissed = new Set<string>();
  /** Jev's reading of each analyzed file, shown in GitHub's file headers; rebuilt by `recompute`. */
  private insights = new Map<string, FileInsight>();
  private readonly insightActions: InsightActions = {
    hide: (path) => this.hideFile(path),
    dismiss: (path) => {
      this.dismissed.add(path);
      this.accepted.delete(path);
      this.recompute();
    },
  };

  constructor(private readonly pr: PrRef) {
    this.key = `${pr.repo}#${pr.number}`;
    this.style = document.createElement("style");
    this.style.id = "gitfilter-style";
    this.style.textContent = HIDE_STYLE + INSIGHT_CSS;
    document.head.append(this.style);

    this.panel = new Panel({
      setQuery: (q) => ((this.query = q), this.recompute()),
      togglePreset: (name) => void this.togglePreset(name),
      toggleExtension: (ext) => (toggle(this.hiddenExtensions, ext), this.recompute()),
      saveRepoRules: (text) => this.saveRepoRules(text),
      show: (path) => void this.show(path),
      alwaysHide: (path) => void this.alwaysHide(path),
      runJev: () => void this.runJev(),
      cancelJev: () => {
        if (this.jevStatus === "running") this.jevStatus = "cancelled";
        this.render();
      },
      hideSuggested: () => {
        for (const [path, s] of this.pendingSuggestions()) this.accepted.set(path, s.reason);
        this.recompute();
      },
      openOptions: () => void send({ type: "options:open" }),
    });

    // Synchronous callback: runs before the next paint, so newly mounted files never flash visible.
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.body, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener(this.onStorageChanged);
    window.addEventListener("focus", this.refreshKeyStatus);

    this.scan();
    void this.init();
  }

  destroy(): void {
    this.alive = false;
    this.observer.disconnect();
    chrome.storage.onChanged.removeListener(this.onStorageChanged);
    window.removeEventListener("focus", this.refreshKeyStatus);
    for (const el of document.querySelectorAll<HTMLElement>("[data-gitfilter-hidden]")) setHidden(el, false);
    removeInsights();
    this.style.remove();
    this.panel.destroy();
  }

  private async init(): Promise<void> {
    const [settings, repoRules, status] = await Promise.all([loadSettings(), loadRepoRules(this.pr.repo), send({ type: "jev:status" })]);
    if (!this.alive) return;
    this.settings = settings;
    this.repoRules = repoRules;
    this.jevHasKey = status.hasKey;
    this.rebuildRules();
    this.recompute();

    const diff = await send({ type: "diff:fetch", repo: this.pr.repo, number: this.pr.number }).catch((e: unknown): DiffResponse => ({ ok: false, error: String(e) }));
    if (!this.alive) return;
    this.diff = diff;
    if (diff.ok) {
      // Re-order paths to PR order, keeping any DOM-only discoveries at the end.
      const inDiff = new Set(diff.files.map((f) => f.path));
      const domOnly = [...this.paths].filter((p) => !inDiff.has(p));
      this.paths.clear();
      for (const p of inDiff) this.paths.add(p);
      for (const p of domOnly) this.paths.add(p);
      const anchors = await Promise.all(diff.files.map((f) => anchorForPath(f.path)));
      if (!this.alive) return;
      diff.files.forEach((f, i) => this.anchorToPath.set(anchors[i]!, f.path));
    }
    this.recompute();
  }

  /** The API key is entered on the options page; re-check when the user comes back to this tab. */
  private readonly refreshKeyStatus = (): void => {
    void send({ type: "jev:status" }).then((s) => {
      if (s.hasKey === this.jevHasKey) return;
      this.jevHasKey = s.hasKey;
      this.render();
    });
  };
  private readonly onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === "sync" && changes.settings) {
      this.settings = normalizeSettings(changes.settings.newValue);
    }
    const repoChange = area === "sync" ? changes[repoKey(this.pr.repo)] : undefined;
    if (repoChange) this.repoRules = typeof repoChange.newValue === "string" ? repoChange.newValue : "";
    // storage.local is restricted to extension pages, so key changes are picked up through `refreshKeyStatus` instead.
    if (area === "sync" && changes.settings) this.refreshKeyStatus();
    if ((area === "sync" && changes.settings) || repoChange) {
      this.rebuildRules();
      this.recompute();
    }
  };

  private rebuildRules(): void {
    const global = parseRules(this.settings.globalRules, "global");
    const repo = parseRules(this.repoRules, this.pr.repo);
    this.rules = [...presetRules(this.settings.presets), ...global.rules, ...repo.rules];
    this.ruleErrors = [...global.errors, ...repo.errors];
  }

  /** Discovers rendered files, then marks containers and tree rows. */
  private scan(): void {
    if (!this.alive) return;
    const files = scanFiles();
    let discovered = false;
    for (const f of files) {
      if (f.path === null) continue;
      this.anchorToPath.set(f.anchor, f.path);
      if (!this.paths.has(f.path)) {
        this.paths.add(f.path);
        discovered = true;
      }
    }
    if (discovered) {
      this.recompute();
      return;
    }
    this.applyMarks(files);
  }

  private applyMarks(files = scanFiles()): void {
    for (const f of files) {
      const path = f.path ?? this.anchorToPath.get(f.anchor);
      setHidden(f.target, path !== undefined && this.decisions.get(path)?.hidden === true);
      if (f.nameSlot && path !== undefined) syncInsight(f.nameSlot, path, this.insights.get(path) ?? null, this.insightActions);
    }
    const rows = scanTree();
    for (const row of rows) {
      if (row.anchor === null) continue;
      const path = this.anchorToPath.get(row.anchor);
      setHidden(row.target, path !== undefined && this.decisions.get(path)?.hidden === true);
    }
    syncDirectoryRows(rows);
  }

  private recompute(): void {
    if (!this.alive) return;
    this.insights = this.computeInsights();
    this.decisions = computeVisibility({
      paths: [...this.paths],
      rules: this.rules,
      hiddenExtensions: this.hiddenExtensions,
      acceptedSuggestions: this.accepted,
      overrides: this.overrides,
      query: this.query,
    });
    this.applyMarks();
    this.render();
  }

  private render(): void {
    if (!this.alive) return;
    const diffNote =
      this.diff.ok === null ? "Loading the PR file list…" : !this.diff.ok ? `Showing files GitHub has rendered so far. Full list unavailable: ${this.diff.error}` : null;
    this.panel.update({
      repo: this.pr.repo,
      paths: [...this.paths],
      decisions: this.decisions,
      inventoryComplete: this.diff.ok === true,
      inventoryNote: diffNote,
      presets: this.settings.presets,
      hiddenExtensions: this.hiddenExtensions,
      repoRules: this.repoRules,
      ruleErrors: this.ruleErrors,
      jev: this.jevView(),
    });
  }

  private async togglePreset(name: PresetName): Promise<void> {
    const presets = this.settings.presets.includes(name) ? this.settings.presets.filter((p) => p !== name) : [...this.settings.presets, name];
    // onStorageChanged applies the change; that also keeps other open PR tabs in sync.
    await saveSettings({ ...this.settings, presets });
  }

  /** Hide button in a file header: accepts Jev's suggestion when there is one, so the reason stays visible. */
  private hideFile(path: string): void {
    const insight = this.insights.get(path);
    if (insight?.suggested && !this.overrides.has(path)) this.accepted.set(path, insight.reason);
    else this.overrides.set(path, true);
    this.recompute();
  }

  private async saveRepoRules(text: string): Promise<string | null> {
    const { errors } = parseRules(text, this.pr.repo);
    if (errors.length > 0) return `Not saved: line ${errors[0]!.lineNumber}: ${errors[0]!.message}`;
    try {
      await saveRepoRules(this.pr.repo, text);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  private async alwaysHide(path: string): Promise<void> {
    const line = exactPathRule(path);
    const text = this.repoRules.trimEnd();
    await saveRepoRules(this.pr.repo, text === "" ? line : `${text}\n${line}`);
  }

  /** Shows a hidden file (dropping a Jev suggestion it was hidden for) and scrolls to it. */
  private async show(path: string): Promise<void> {
    if (this.decisions.get(path)?.reason?.kind === "suggestion") {
      this.accepted.delete(path);
      this.dismissed.add(path);
    }
    this.overrides.delete(path);
    this.recompute();
    // Still hidden by a rule, file type or search: force it visible.
    if (this.decisions.get(path)?.hidden) {
      this.overrides.set(path, false);
      this.recompute();
    }
    location.hash = await anchorForPath(path);
  }

  // -------------------------------------------------------------------------
  // Jev

  private jevBlocker(): string | null {
    const jev = this.settings.jev;
    if (!jev.consented) return "Confirm the data-sharing notice in GitFilter options first.";
    if (!this.jevHasKey) return "Add your TypeSafe API key in GitFilter options.";
    if (this.diff.ok === null) return "Loading the PR diff…";
    if (this.diff.ok === false) return `PR diff unavailable: ${this.diff.error}`;
    if (this.diff.visibility === "private" && !jev.allowPrivateRepos) {
      return "This repository is private. Enable “Allow private repositories” in GitFilter options to send its diffs to TypeSafe.";
    }
    return null;
  }

  /** Jev's reading of each analyzed file under the current settings. */
  private computeInsights(): Map<string, FileInsight> {
    const out = new Map<string, FileInsight>();
    if (!this.settings.jev.enabled) return out;
    for (const [path, result] of this.jevResults) {
      const c = result.kind === "binary" ? BINARY_FILE : classify(result.answers, this.settings.jev);
      out.set(path, { ...c, suggested: c.low && !this.dismissed.has(path) });
    }
    return out;
  }

  /** Files Jev suggests hiding that are still visible. */
  private pendingSuggestions(): [string, FileInsight][] {
    return [...this.insights].filter(([path, insight]) => insight.suggested && this.decisions.get(path)?.hidden !== true);
  }

  private jevView(): JevView {
    const model = [...this.jevResults.values()].find((r) => r.kind === "answers");
    return {
      enabled: this.settings.jev.enabled,
      blocker: this.jevBlocker(),
      status: this.jevStatus,
      completed: this.jevCompleted,
      total: this.jevTotal,
      errors: this.jevErrors,
      analyzed: this.jevResults.size,
      suggested: [...this.insights.values()].filter((i) => i.suggested).length,
      pending: this.pendingSuggestions().length,
      model: model?.kind === "answers" ? model.model : null,
    };
  }

  private async runJev(): Promise<void> {
    if (this.jevStatus === "running" || this.jevBlocker() !== null || !this.diff.ok) return;
    const { visibility } = this.diff;
    const title = prTitleFromDocumentTitle(document.title);
    const todo = this.diff.files.filter((f) => !this.jevResults.has(f.path) && this.decisions.get(f.path)?.hidden !== true).slice(0, MAX_FILES_PER_RUN);

    this.jevStatus = "running";
    this.jevCompleted = 0;
    this.jevTotal = todo.length;
    this.jevErrors = [];
    this.render();

    let next = 0;
    const lane = async () => {
      while (this.alive && this.jevStatus === "running" && next < todo.length) {
        const file = todo[next++]!;
        await this.scoreFile(file, title, visibility);
        this.jevCompleted++;
        // New answers change file headers as well as the panel.
        this.recompute();
      }
    };
    await Promise.all(Array.from({ length: JEV_CONCURRENCY }, lane));
    if (!this.alive) return;
    if (this.jevStatus === "running") this.jevStatus = "done";
    this.render();
  }

  private async scoreFile(file: DiffFile, title: string, visibility: "public" | "private"): Promise<void> {
    if (file.status === "binary") {
      this.jevResults.set(file.path, { kind: "binary" });
      return;
    }
    const request = { type: "jev:score", state: buildState(title, file), digest: file.digest, visibility } as const;
    // One retry covers a service worker restart (rejected message) or a retryable API error after the worker's own backoff.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await send(request);
        if (!this.alive) return;
        if (res.ok) {
          this.jevResults.set(file.path, { kind: "answers", answers: res.answers, model: res.model });
          return;
        }
        if (!res.retryable || attempt === 2) {
          this.jevErrors.push(`${file.path}: ${res.error}`);
          // A rejected key or disabled setting fails every file the same way; stop instead of repeating it.
          if (!res.retryable) this.jevStatus = "cancelled";
          return;
        }
      } catch (e) {
        if (attempt === 2) this.jevErrors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

function toggle<T>(set: Set<T>, value: T): void {
  if (!set.delete(value)) set.add(value);
}

// ---------------------------------------------------------------------------
// Page lifecycle: GitHub navigates without full reloads (Turbo and React soft navigation).

let session: Session | null = null;

function sync(): void {
  const pr = parsePrFilesPath(location.pathname);
  const key = pr ? `${pr.repo}#${pr.number}` : null;
  if (session?.key === key) return;
  session?.destroy();
  session = pr ? new Session(pr) : null;
}

for (const event of ["turbo:load", "turbo:render", "soft-nav:end", "soft-nav:react-done"]) {
  document.addEventListener(event, sync);
}
window.addEventListener("popstate", sync);
// Some React-to-React navigations fire none of the events above; a cheap URL check catches them.
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    sync();
  }
}, 500);
sync();
