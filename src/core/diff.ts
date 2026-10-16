export type ChangeStatus = "added" | "removed" | "modified" | "renamed" | "binary";

export interface FileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  /** Hunk text (headers + lines), truncated to `maxExcerpt` characters. */
  readonly excerpt: string;
  readonly truncated: boolean;
}

/** Parses `git diff` output as served by `https://github.com/<o>/<r>/pull/<n>.diff`. */
export function parseUnifiedDiff(diff: string, maxExcerpt = 3000): FileChange[] {
  return splitDiffChunks(diff).flatMap((chunk) => parseChunk(chunk, maxExcerpt) ?? []);
}

/** One `diff --git …` section per file, in order. */
export function splitDiffChunks(diff: string): string[] {
  return diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
}

export function parseChunk(chunk: string, maxExcerpt = 3000): FileChange | null {
  const lines = chunk.split("\n");
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let isNew = false;
  let isDeleted = false;
  let isBinary = false;
  let additions = 0;
  let deletions = 0;
  let hunkStart = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunkStart === -1) {
      if (line.startsWith("@@")) {
        hunkStart = i;
      } else if (line.startsWith("new file mode")) isNew = true;
      else if (line.startsWith("deleted file mode")) isDeleted = true;
      else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10));
      else if (line.startsWith("--- ")) oldPath = stripPrefix(unquote(line.slice(4)), "a/");
      else if (line.startsWith("+++ ")) newPath = stripPrefix(unquote(line.slice(4)), "b/");
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") isBinary = true;
      continue;
    }
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }

  const fromHeader = pathsFromHeader(lines[0]!);
  const path = renameTo ?? (newPath && newPath !== "/dev/null" ? newPath : undefined) ?? (oldPath !== "/dev/null" ? oldPath : undefined) ?? fromHeader?.b;
  if (!path) return null;
  const previous = renameFrom ?? (oldPath && oldPath !== "/dev/null" && oldPath !== path ? oldPath : undefined);

  const status: ChangeStatus = isBinary
    ? "binary"
    : isNew
      ? "added"
      : isDeleted
        ? "removed"
        : previous !== undefined
          ? "renamed"
          : "modified";

  let excerpt = hunkStart === -1 ? "" : lines.slice(hunkStart).join("\n").trimEnd();
  const truncated = excerpt.length > maxExcerpt;
  if (truncated) excerpt = excerpt.slice(0, maxExcerpt);

  return { path, ...(previous !== undefined ? { oldPath: previous } : {}), status, additions, deletions, excerpt, truncated };
}

/** `diff --git a/x b/x` → paths; only reliable when both sides are equal (binary files without ---/+++ lines). */
function pathsFromHeader(header: string): { a: string; b: string } | null {
  const rest = header.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/);
    if (!m) return null;
    return { a: stripPrefix(unquote(m[1]!), "a/"), b: stripPrefix(unquote(m[2]!), "b/") };
  }
  // Unquoted: both halves have equal length when the path did not change.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    return { a: stripPrefix(rest.slice(0, half), "a/"), b: stripPrefix(rest.slice(half + 1), "b/") };
  }
  return null;
}

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };

/** Git C-style quoting (`"a/caf\303\251.txt"`) → UTF-8 string. Also strips the tab git appends before timestamps. */
function unquote(s: string): string {
  const value = s.replace(/\t.*$/, "");
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const inner = value.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const next = inner[++i]!;
    if (/[0-7]/.test(next)) {
      const oct = inner.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(ESCAPES[next] ?? next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
