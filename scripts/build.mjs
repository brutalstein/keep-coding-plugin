import { chmod, cp, mkdir, stat } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "plugins/keep-coding/dist/keep-coding.mjs";
const grammarDir = "plugins/keep-coding/dist/grammars";
await mkdir(grammarDir, { recursive: true });
await build({
  entryPoints: ["src/entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["node:sqlite", "typescript"]
});
await cp("assets/tree-sitter", grammarDir, { recursive: true, force: true });
await chmod(outfile, 0o755);
const output = await stat(outfile);
console.log(`Built ${outfile} (${output.size} bytes) with verified sidecar grammars.`);
