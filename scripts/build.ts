/** Bundles the extension into dist/ (load that folder as an unpacked extension). `--watch` rebuilds on change. */
import { cp, mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

async function build(): Promise<void> {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  // Content scripts cannot be ES modules, so the content script is bundled separately as an IIFE.
  const builds = [
    { entrypoints: [join(root, "src/background.ts"), join(root, "src/options/options.ts")], format: "esm" as const },
    { entrypoints: [join(root, "src/content/main.ts")], format: "iife" as const, naming: "content.js" },
  ];
  for (const { entrypoints, format, naming } of builds) {
    const result = await Bun.build({ entrypoints, outdir: dist, naming: naming ?? "[name].js", target: "browser", format, sourcemap: "linked" });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error("Build failed");
    }
  }
  await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
  await cp(join(root, "src/options/options.html"), join(dist, "options.html"));
  await cp(join(root, "src/options/options.css"), join(dist, "options.css"));
  await cp(join(root, "icons"), join(dist, "icons"), { recursive: true });
  console.log(`Built ${dist}`);
}

await build();
if (process.argv.includes("--watch")) {
  let timer: Timer | undefined;
  watch(join(root, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e: unknown) => console.error(e)), 100);
  });
  console.log("Watching src/ …");
}
