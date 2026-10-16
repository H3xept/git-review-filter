/**
 * Jev indicators in GitHub's own file headers: the file kind, a review-attention meter and, for files Jev
 * suggests hiding, a "Low interest" label. Every header also gets a hide button. Styles use GitHub's Primer
 * CSS variables, so the labels follow the page theme.
 */
import { ATTENTION_LEVELS, ROLE_LABELS, type Classification } from "../core/jev";
import { h, octicon } from "./dom";

export interface FileInsight extends Classification {
  /** Jev's suggestion stands: the file is low interest and the user has not dismissed it. */
  readonly suggested: boolean;
}

export interface InsightActions {
  hide(path: string): void;
  dismiss(path: string): void;
}

const BOX = "gitfilter-insight";
/** "None", "Low", "Medium", "High": the names the rubric gives each attention level. */
const LEVEL_NAMES = ATTENTION_LEVELS.map((text) => text.slice(0, text.indexOf(":")));

/** The rubric level nearest to Jev's expected score (0.4 → 0 None, 1.6 → 2 Medium). */
function attentionLevel(score: number): number {
  return Math.min(3, Math.max(0, Math.round(score)));
}

/** Inserts or refreshes the indicators after `slot`; leaves the DOM untouched when nothing changed. */
export function syncInsight(slot: HTMLElement, path: string, insight: FileInsight | null, actions: InsightActions): void {
  const key = JSON.stringify([path, insight]);
  const next = slot.nextElementSibling;
  const existing = next instanceof HTMLElement && next.classList.contains(BOX) ? next : null;
  // The MutationObserver sees this insertion too; an unchanged key ends that loop.
  if (existing?.dataset.key === key) return;
  const box = buildInsight(path, insight, actions);
  box.dataset.key = key;
  if (existing) existing.replaceWith(box);
  else slot.after(box);
}

export function removeInsights(): void {
  for (const el of document.querySelectorAll(`.${BOX}`)) el.remove();
}

/** Header clicks can toggle or navigate on GitHub; keep them to the button. */
const handle = (action: () => void) => (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  action();
};

function buildInsight(path: string, insight: FileInsight | null, actions: InsightActions): HTMLElement {
  const box = h("span", { class: BOX });
  if (insight) {
    const level = attentionLevel(insight.attention);
    const meter = h("span", { class: "gitfilter-meter", "aria-hidden": "true" }, ...[1, 2, 3].map((i) => h("span", { class: i <= level ? "on" : "" })));
    box.append(
      h("span", { class: "gitfilter-label", title: `Jev: ${ROLE_LABELS[insight.role]} (${Math.round(insight.roleProbability * 100)}%)` }, ROLE_LABELS[insight.role]),
      h(
        "span",
        { class: "gitfilter-label gitfilter-attention", "data-level": String(level), title: `Jev review attention ${insight.attention.toFixed(2)} of 3\n${ATTENTION_LEVELS[level]}` },
        meter,
        `${LEVEL_NAMES[level]} ${insight.attention.toFixed(1)}`,
      ),
    );
    if (insight.suggested) {
      box.append(
        h(
          "span",
          { class: "gitfilter-label gitfilter-suggested", title: `Jev suggests hiding this file: ${insight.reason}` },
          "Low interest",
          h("button", { type: "button", class: "gitfilter-btn gitfilter-dismiss", title: "Dismiss the suggestion", "aria-label": "Dismiss the suggestion", onclick: handle(() => actions.dismiss(path)) }, octicon("x12", 12)),
        ),
      );
    }
  }
  const hideTitle = insight?.suggested ? "Hide this file (accept Jev's suggestion)" : "Hide this file";
  box.append(h("button", { type: "button", class: "gitfilter-btn", title: hideTitle, "aria-label": hideTitle, onclick: handle(() => actions.hide(path)) }, octicon("eyeClosed16", 16)));
  return box;
}

export const INSIGHT_CSS = `
/* The classic header lays out its parts inline, so the indicators would wrap below a long path; a flex row truncates the path instead. */
.file-info:has(> .${BOX}) { display: flex; align-items: center; column-gap: 4px; }
.file-info:has(> .${BOX}) > .Truncate { min-width: 0; }
.${BOX} { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; flex-shrink: 0; vertical-align: middle;
  font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
.${BOX} .gitfilter-label { display: inline-flex; align-items: center; gap: 4px; height: 20px; box-sizing: border-box; padding: 0 7px;
  white-space: nowrap; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 2em; color: var(--fgColor-muted, #59636e); }
.${BOX} .gitfilter-attention { --gitfilter-level: var(--fgColor-muted, #59636e); color: var(--gitfilter-level); border-color: var(--gitfilter-level); }
.${BOX} .gitfilter-attention[data-level="0"], .${BOX} .gitfilter-attention[data-level="1"] { --gitfilter-level: var(--fgColor-success, #1a7f37); }
.${BOX} .gitfilter-attention[data-level="2"] { --gitfilter-level: var(--fgColor-attention, #9a6700); }
.${BOX} .gitfilter-attention[data-level="3"] { --gitfilter-level: var(--fgColor-severe, #bc4c00); }
.${BOX} .gitfilter-meter { display: inline-flex; gap: 1px; }
.${BOX} .gitfilter-meter span { width: 6px; height: 8px; border-radius: 1px; background: var(--borderColor-default, #d1d9e0); }
.${BOX} .gitfilter-meter span.on { background: var(--gitfilter-level); }
.${BOX} .gitfilter-suggested { color: var(--fgColor-accent, #0969da); border-color: var(--borderColor-accent-emphasis, #0969da); padding-right: 3px; }
.${BOX} .gitfilter-btn { all: unset; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  border-radius: 6px; color: var(--fgColor-muted, #59636e); cursor: pointer; }
.${BOX} .gitfilter-btn:hover { color: var(--fgColor-default, #1f2328); background: var(--control-transparent-bgColor-hover, #818b981a); }
.${BOX} .gitfilter-btn:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: -2px; }
.${BOX} .gitfilter-dismiss { width: 16px; height: 16px; border-radius: 50%; color: inherit; }
`;
