import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "plugins/keep-coding/dist/keep-coding.mjs";
await mkdir("plugins/keep-coding/dist", { recursive: true });
await build({
  entryPoints: ["src/entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["node:sqlite"]
});
await chmod(outfile, 0o755);
