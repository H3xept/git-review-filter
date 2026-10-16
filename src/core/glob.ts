/**
 * Gitignore-flavoured glob matching for repository-relative paths.
 *
 * - A pattern without a slash matches any single path segment
 *   (`*.spec.*` matches `src/a/foo.spec.ts`; `node_modules` matches every file under it).
 * - A pattern containing a slash is anchored at the repository root
 *   (`src/generated/**`, `/docs`). A leading slash is optional.
 * - A trailing slash restricts the pattern to directories (`docs/` matches `docs/a.md`, not a file named `docs`).
 * - A pattern that matches a directory also matches every file below it.
 * - `*` and `?` never cross `/`; `**` crosses directories; `[abc]`, `[!a-z]` and `{a,b}` are supported.
 */
export interface GlobMatcher {
  readonly source: string;
  test(path: string): boolean;
}

export function compileGlob(pattern: string, options: { nocase?: boolean } = {}): GlobMatcher {
  let body = pattern.trim();
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.replace(/\/+$/, "");
  const anchored = body.includes("/");
  body = body.replace(/^\/+/, "");
  if (body === "") throw new SyntaxError(`Empty glob: "${pattern}"`);

  const re = new RegExp(`^${globToRegExpSource(body)}$`, options.nocase ? "i" : "");

  return {
    source: pattern,
    test(path: string): boolean {
      const segments = path.split("/");
      // Directory candidates exclude the last segment (the file name) when dirOnly.
      const limit = dirOnly ? segments.length - 1 : segments.length;
      if (anchored) {
        for (let end = 1; end <= limit; end++) {
          if (re.test(segments.slice(0, end).join("/"))) return true;
        }
        return false;
      }
      for (let i = 0; i < limit; i++) {
        if (re.test(segments[i]!)) return true;
      }
      return false;
    },
  };
}

function globToRegExpSource(glob: string): string {
  let out = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    switch (c) {
      case "*": {
        if (glob[i + 1] === "*") {
          const atSegmentStart = i === 0 || glob[i - 1] === "/";
          const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === "/";
          if (atSegmentStart && atSegmentEnd) {
            if (glob[i + 2] === "/") {
              out += "(?:.*/)?"; // `**/` → zero or more directories
              i += 2;
            } else {
              out += ".*"; // trailing `**` → everything below
              i += 1;
            }
            break;
          }
          i += 1; // `a**b` behaves like `a*b`
        }
        out += "[^/]*";
        break;
      }
      case "?":
        out += "[^/]";
        break;
      case "[": {
        const close = glob.indexOf("]", i + 2);
        if (close === -1) {
          out += "\\[";
          break;
        }
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = close;
        break;
      }
      case "{":
        braceDepth++;
        out += "(?:";
        break;
      case "}":
        if (braceDepth > 0) {
          braceDepth--;
          out += ")";
        } else out += "\\}";
        break;
      case ",":
        out += braceDepth > 0 ? "|" : ",";
        break;
      case "\\":
        if (i + 1 < glob.length) {
          out += escapeRegExp(glob[++i]!);
        } else out += "\\\\";
        break;
      default:
        out += escapeRegExp(c);
    }
  }
  if (braceDepth > 0) throw new SyntaxError(`Unclosed "{" in glob: "${glob}"`);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
