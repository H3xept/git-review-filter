/**
 * GitHub "Files changed" DOM adapter for both the classic view (`/pull/N/files`) and the
 * React view (`/pull/N/changes`). Every file is keyed by its anchor id `diff-<sha256(path)>`,
 * which the diff container and its file-tree row share.
 */

export const HIDDEN_ATTR = "data-gitfilter-hidden";

export interface PrRef {
  /** `owner/name` */
  readonly repo: string;
  readonly number: number;
}

/** `/owner/repo/pull/12/files`, `/owner/repo/pull/12/changes/<a>..<b>` → PR; anything else → null. */
export function parsePrFilesPath(pathname: string): PrRef | null {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)(?:\/[^/]*)?\/?$/);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

/** document.title is "<title> by <author> · Pull Request #<n> · <owner>/<repo> · GitHub" in both views. */
export function prTitleFromDocumentTitle(title: string): string {
  return title.match(/^(.*) by \S+ · Pull Request #\d+/)?.[1]?.trim() ?? title;
}

export interface FileElement {
  readonly anchor: string;
  /** Null when the header has not rendered a readable path yet. */
  readonly path: string | null;
  /** Outermost element that represents the file; hidden as a whole. */
  readonly target: HTMLElement;
  /** The header element that shows the file name; GitFilter inserts its file indicators right after it. */
  readonly nameSlot: HTMLElement | null;
}

const CLASSIC_FILE = "div.file.js-file[data-tagsearch-path]";
const CLASSIC_NAME = ".file-header .file-info > .Truncate";
/** React view containers carry a CSS-module class like `Diff-module__diffTargetable--x1y2`. */
const REACT_FILE = 'div[id^="diff-"][class*="targetable" i]:not(.js-file)';
const REACT_NAME = '[class*="file-name"]';

export function scanFiles(root: ParentNode = document): FileElement[] {
  const out: FileElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(CLASSIC_FILE)) {
    out.push({
      anchor: el.id,
      path: el.dataset.tagsearchPath ?? null,
      target: el.closest<HTMLElement>("copilot-diff-entry") ?? el,
      nameSlot: el.querySelector<HTMLElement>(CLASSIC_NAME),
    });
  }
  for (const el of root.querySelectorAll<HTMLElement>(REACT_FILE)) {
    out.push({ anchor: el.id, path: reactHeaderPath(el), target: el, nameSlot: el.querySelector<HTMLElement>(REACT_NAME) });
  }
  return out;
}

const BIDI_MARKS = /[\u200E\u200F]/g;

/** Reads the file path from a React-view header; renames show as `old → new` with an sr-only "renamed to" hint. */
export function reactHeaderPath(container: Element): string | null {
  const code = container.querySelector('[class*="file-name"] code');
  if (!code) return null;
  const renamed = code.querySelector(".sr-only")?.textContent?.split(" renamed to ", 2)[1];
  let text = (renamed ?? code.textContent ?? "").replace(BIDI_MARKS, "").trim();
  const arrow = text.lastIndexOf("→");
  if (renamed === undefined && arrow !== -1) text = text.slice(arrow + 1).trim();
  return text === "" ? null : text;
}

export interface TreeRow {
  /** Null for directory rows. */
  readonly anchor: string | null;
  readonly target: HTMLElement;
}

const CLASSIC_TREE_ROW = "file-tree li.js-tree-node";
const REACT_TREE_ROW = 'li[class*="file-tree-row"]';

export function scanTree(root: ParentNode = document): TreeRow[] {
  const out: TreeRow[] = [];
  for (const li of root.querySelectorAll<HTMLElement>(CLASSIC_TREE_ROW)) {
    out.push({ anchor: li.id.startsWith("file-tree-item-diff-") ? li.id.slice("file-tree-item-".length) : null, target: li });
  }
  for (const li of root.querySelectorAll<HTMLElement>(REACT_TREE_ROW)) {
    const href = li.querySelector<HTMLAnchorElement>(':scope a[href*="#diff-"]')?.getAttribute("href");
    // A directory row contains its children's links, so only rows whose own link is the first one count as files.
    const ownLink = href && !li.querySelector(`:scope ${REACT_TREE_ROW}`) ? href.slice(href.indexOf("#") + 1) : null;
    out.push({ anchor: ownLink, target: li });
  }
  return out;
}

export async function anchorForPath(path: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)));
  return "diff-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sets or clears the hidden marker; returns true when the element changed. */
export function setHidden(el: HTMLElement, hidden: boolean): boolean {
  if (el.hasAttribute(HIDDEN_ATTR) === hidden) return false;
  el.toggleAttribute(HIDDEN_ATTR, hidden);
  return true;
}

/** Hides directory rows whose every file row is hidden; shows them again otherwise. */
export function syncDirectoryRows(rows: readonly TreeRow[]): void {
  const dirs = new Map<HTMLElement, { files: number; hidden: number }>();
  for (const row of rows) if (row.anchor === null) dirs.set(row.target, { files: 0, hidden: 0 });
  if (dirs.size === 0) return;
  for (const row of rows) {
    if (row.anchor === null) continue;
    const hidden = row.target.hasAttribute(HIDDEN_ATTR);
    for (let el = row.target.parentElement; el; el = el.parentElement) {
      const counts = dirs.get(el);
      if (!counts) continue;
      counts.files++;
      if (hidden) counts.hidden++;
    }
  }
  for (const [dir, { files, hidden }] of dirs) setHidden(dir, files > 0 && files === hidden);
}
export const HIDE_STYLE = `[${HIDDEN_ATTR}] { display: none !important; }`;
