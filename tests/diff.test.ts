import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "../src/core/diff";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
diff --git a/new.spec.ts b/new.spec.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.spec.ts
@@ -0,0 +1,2 @@
+test("x", () => {});
+// --- not a header
diff --git a/old.md b/old.md
deleted file mode 100644
index 4444444..0000000
--- a/old.md
+++ /dev/null
@@ -1 +0,0 @@
-# Old
diff --git a/lib/a.ts b/lib/b.ts
similarity index 90%
rename from lib/a.ts
rename to lib/b.ts
index 5555555..6666666 100644
--- a/lib/a.ts
+++ b/lib/b.ts
@@ -1 +1 @@
-x
+y
diff --git a/moved.txt b/dir/moved.txt
similarity index 100%
rename from moved.txt
rename to dir/moved.txt
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/logo.png differ
diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"
index 8888888..9999999 100644
--- "a/caf\\303\\251 menu.txt"
+++ "b/caf\\303\\251 menu.txt"
@@ -1 +1 @@
-a
+b
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF);
  const byPath = new Map(files.map((f) => [f.path, f]));

  test("returns one entry per file in order", () => {
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "new.spec.ts", "old.md", "lib/b.ts", "dir/moved.txt", "logo.png", "café menu.txt"]);
  });

  test("counts additions and deletions, including content lines that look like headers", () => {
    expect(byPath.get("src/app.ts")).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(byPath.get("new.spec.ts")).toMatchObject({ status: "added", additions: 2, deletions: 0 });
  });

  test("detects deleted, renamed, pure-rename and binary files", () => {
    expect(byPath.get("old.md")).toMatchObject({ status: "removed", deletions: 1 });
    expect(byPath.get("lib/b.ts")).toMatchObject({ status: "renamed", oldPath: "lib/a.ts" });
    expect(byPath.get("dir/moved.txt")).toMatchObject({ status: "renamed", oldPath: "moved.txt", excerpt: "" });
    expect(byPath.get("logo.png")).toMatchObject({ status: "binary" });
  });

  test("excerpt starts at the first hunk and is truncated to the limit", () => {
    expect(byPath.get("src/app.ts")!.excerpt.startsWith("@@ -1,3 +1,4 @@")).toBe(true);
    const [short] = parseUnifiedDiff(DIFF, 10);
    expect(short).toMatchObject({ excerpt: "@@ -1,3 +1", truncated: true });
  });
});
