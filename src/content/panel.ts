import { describeReason, extensionKey, PRESET_NAMES, type Decision, type PresetName, type RuleError } from "../core/rules";
import { h } from "./dom";
import { PANEL_CSS } from "./panel-css";

export interface JevView {
  readonly enabled: boolean;
  /** Why analysis cannot run (missing key, private repo, diff unavailable); null when it can. */
  readonly blocker: string | null;
  readonly status: "idle" | "running" | "done" | "cancelled";
  readonly completed: number;
  readonly total: number;
  readonly errors: readonly string[];
  readonly analyzed: number;
  /** Files Jev suggests hiding, hidden or not. */
  readonly suggested: number;
  /** Suggested files that are still visible; "Hide N" hides these. */
  readonly pending: number;
  readonly model: string | null;
}

export interface PanelView {
  readonly repo: string;
  readonly paths: readonly string[];
  readonly decisions: ReadonlyMap<string, Decision>;
  /** False until the PR diff is parsed; counts then cover only files GitHub has rendered. */
  readonly inventoryComplete: boolean;
  readonly inventoryNote: string | null;
  readonly presets: readonly PresetName[];
  readonly hiddenExtensions: ReadonlySet<string>;
  readonly repoRules: string;
  readonly ruleErrors: readonly RuleError[];
  readonly jev: JevView;
}

export interface PanelActions {
  setQuery(query: string): void;
  togglePreset(name: PresetName): void;
  toggleExtension(ext: string): void;
  saveRepoRules(text: string): Promise<string | null>;
  /** Makes a hidden file visible again and scrolls to it. */
  show(path: string): void;
  alwaysHide(path: string): void;
  runJev(): void;
  cancelJev(): void;
  hideSuggested(): void;
  openOptions(): void;
}

/** Paths render with `direction: rtl` so long ones elide on the left; LRM marks keep leading/trailing punctuation in place. */
const ltr = (path: string) => `\u200E${path}\u200E`;

export class Panel {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly body: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly rulesBox: HTMLTextAreaElement;
  private readonly rulesSummary: HTMLElement;
  private readonly rulesStatus: HTMLElement;
  /** Re-rendered on every update; the search box and rules editor live outside so typing keeps focus. */
  private readonly dynamic: HTMLElement;
  private view: PanelView | null = null;
  private renderQueued = false;
  private collapsed = sessionStorage.getItem("gitfilter:collapsed") === "1";
  private hiddenOpen = false;
  private rulesMessage: { text: string; error: boolean } | null = null;
  private shownRepoRules: string | null = null;

  constructor(private readonly actions: PanelActions) {
    this.host = h("div", { id: "gitfilter-panel-host" });
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.append(h("style", {}, PANEL_CSS));

    this.badge = h("span", { class: "badge" });
    this.search = h("input", {
      type: "search",
      placeholder: "Filter: name, *.spec.*, re:^src/, !test",
      oninput: () => this.actions.setQuery(this.search.value),
    });
    this.rulesBox = h("textarea", { rows: 4, spellcheck: false, placeholder: "# one rule per line\n*.spec.*\n!critical.spec.ts\nre:^generated/" });
    this.rulesSummary = h("summary");
    this.rulesStatus = h("div");
    this.dynamic = h("div", { class: "sections" });
    const save = h(
      "button",
      {
        class: "primary",
        onclick: async () => {
          const error = await this.actions.saveRepoRules(this.rulesBox.value);
          this.rulesMessage = error ? { text: error, error: true } : { text: "Saved", error: false };
          if (this.view) this.update(this.view);
        },
      },
      "Save",
    );
    const rules = h(
      "details",
      {},
      this.rulesSummary,
      this.rulesBox,
      h("div", { class: "row" }, save, h("span", { class: "spacer" }), h("span", { class: "note" }, "glob · !negate · re:regex")),
      this.rulesStatus,
    );

    const header = h(
      "div",
      { class: "header", onclick: (e: Event) => (e.target as Element).closest("button") === null && this.toggleCollapsed() },
      h("strong", {}, "GitFilter"),
      this.badge,
      h("span", { class: "spacer" }),
      h("button", { class: "icon", title: "Options", onclick: () => this.actions.openOptions() }, "⚙"),
      h("button", { class: "icon", title: "Collapse", onclick: () => this.toggleCollapsed() }, "▾"),
    );
    this.body = h("div", { class: "body" }, this.search, this.dynamic, rules);
    this.root.append(h("div", { class: "panel" }, header, this.body));
    this.applyCollapsed();
    document.body.append(this.host);
  }

  destroy(): void {
    this.host.remove();
  }

  update(view: PanelView): void {
    this.view = view;
    // Refresh the editor when rules change elsewhere (options page, "Always hide"), unless the user is typing.
    if (view.repoRules !== this.shownRepoRules && this.root.activeElement !== this.rulesBox) {
      this.rulesBox.value = view.repoRules;
      this.shownRepoRules = view.repoRules;
    }
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    sessionStorage.setItem("gitfilter:collapsed", this.collapsed ? "1" : "0");
    this.applyCollapsed();
  }

  private applyCollapsed(): void {
    this.host.classList.toggle("collapsed", this.collapsed);
    this.body.hidden = this.collapsed;
  }

  private render(): void {
    const v = this.view;
    if (!v) return;
    const hidden = v.paths.filter((p) => v.decisions.get(p)?.hidden);
    this.badge.textContent = `${hidden.length} of ${v.paths.length}${v.inventoryComplete ? "" : " loaded"} hidden`;
    this.dynamic.replaceChildren(
      ...(v.inventoryNote ? [h("div", { class: "note" }, v.inventoryNote)] : []),
      this.renderPresets(v),
      this.renderExtensions(v),
      this.renderJev(v),
      this.renderHidden(v, hidden),
    );
    this.renderRulesStatus(v);
  }

  private renderPresets(v: PanelView): HTMLElement {
    return h(
      "div",
      { class: "field" },
      h("span", { class: "label", title: "Presets apply to every repository" }, "Presets"),
      h(
        "div",
        { class: "chips" },
        ...PRESET_NAMES.map((name) => {
          const on = v.presets.includes(name);
          return h("button", { class: on ? "chip on" : "chip", "aria-pressed": String(on), onclick: () => this.actions.togglePreset(name) }, name);
        }),
      ),
    );
  }

  private renderExtensions(v: PanelView): HTMLElement {
    const counts = new Map<string, number>();
    for (const p of v.paths) {
      const ext = extensionKey(p);
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return h(
      "div",
      { class: "field" },
      h("span", { class: "label", title: "File types in this pull request; click one to hide it" }, "Types"),
      h(
        "div",
        { class: "chips" },
        ...sorted.map(([ext, n]) => {
          const off = v.hiddenExtensions.has(ext);
          return h("button", { class: off ? "chip off" : "chip", title: off ? "Hidden; click to show" : "Click to hide", onclick: () => this.actions.toggleExtension(ext) }, `${ext} `, h("span", { class: "count" }, String(n)));
        }),
      ),
    );
  }

  private renderJev(v: PanelView): HTMLElement {
    const j = v.jev;
    const content = h("div", { class: "jev" });
    const field = h("div", { class: "field" }, h("span", { class: "label" }, "Jev"), content);
    if (!j.enabled) {
      content.append(h("span", { class: "note" }, "Off · ", h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), this.actions.openOptions()) }, "Enable in options")));
      return field;
    }
    if (j.blocker) {
      content.append(h("span", { class: "error" }, j.blocker));
      return field;
    }
    const row = h("div", { class: "row" });
    if (j.status === "running") {
      row.append(h("progress", { max: j.total, value: j.completed }), h("span", { class: "note" }, `${j.completed}/${j.total}`), h("button", { onclick: () => this.actions.cancelJev() }, "Cancel"));
    } else {
      row.append(h("button", { class: j.analyzed === 0 ? "primary" : "", onclick: () => this.actions.runJev() }, j.analyzed === 0 ? "Analyze" : "Analyze new"));
      if (j.analyzed > 0) {
        row.append(h("span", { class: "note", title: j.model ? `Model: ${j.model}` : "" }, `${j.suggested} of ${j.analyzed} low interest`));
      }
    }
    if (j.pending > 0) row.append(h("span", { class: "spacer" }), h("button", { class: "primary", title: "Hide the files Jev marks “Low interest”", onclick: () => this.actions.hideSuggested() }, `Hide ${j.pending}`));
    content.append(row);
    if (j.errors.length > 0) {
      content.append(h("div", { class: "error", title: j.errors.join("\n") }, j.errors[0]!, j.errors.length > 1 ? ` (+${j.errors.length - 1} more)` : ""));
    }
    return field;
  }

  private renderHidden(v: PanelView, hidden: readonly string[]): HTMLElement {
    // Creating the element with `open` set also fires "toggle"; re-rendering on that event would loop every frame.
    const ontoggle = () => {
      if (details.open === this.hiddenOpen) return;
      this.hiddenOpen = details.open;
      this.update(this.view!);
    };
    const details = h("details", { open: this.hiddenOpen, ontoggle });
    details.append(h("summary", {}, "Hidden files ", h("span", { class: "count" }, String(hidden.length))));
    if (!this.hiddenOpen) return details;
    if (hidden.length === 0) {
      details.append(h("div", { class: "note" }, "Nothing is hidden."));
      return details;
    }
    const list = h("ul", { class: "list" });
    for (const path of hidden) {
      const reason = v.decisions.get(path)?.reason;
      const pinnable = reason?.kind === "suggestion" || reason?.kind === "manual";
      list.append(
        h(
          "li",
          {},
          h("div", { class: "path", title: path }, ltr(path)),
          h(
            "div",
            { class: "row" },
            h("span", { class: "note reason" }, reason ? describeReason(reason) : ""),
            h("span", { class: "spacer" }),
            pinnable && h("button", { title: `Add a rule for this file to ${v.repo}`, onclick: () => this.actions.alwaysHide(path) }, "Always hide"),
            h("button", { onclick: () => this.actions.show(path) }, "Show"),
          ),
        ),
      );
    }
    details.append(list);
    return details;
  }

  private renderRulesStatus(v: PanelView): void {
    const lineCount = v.repoRules.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).length;
    this.rulesSummary.replaceChildren(`Rules for ${v.repo} `, h("span", { class: "count" }, String(lineCount)));
    this.rulesStatus.replaceChildren(
      ...(this.rulesMessage ? [h("div", { class: this.rulesMessage.error ? "error" : "note" }, this.rulesMessage.text)] : []),
      ...v.ruleErrors.map((e) => h("div", { class: "error" }, `${e.origin} line ${e.lineNumber}: ${e.line} — ${e.message}`)),
    );
  }
}
