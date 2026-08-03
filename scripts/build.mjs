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
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __keepCodingCreateRequire } from 'node:module';",
      "import { fileURLToPath as __keepCodingFileURLToPath } from 'node:url';",
      "import { dirname as __keepCodingDirname } from 'node:path';",
      "const require = __keepCodingCreateRequire(import.meta.url);",
      "const __filename = __keepCodingFileURLToPath(import.meta.url);",
      "const __dirname = __keepCodingDirname(__filename);"
    ].join("\n")
  },
  external: ["node:sqlite"]
});
await chmod(outfile, 0o755);
