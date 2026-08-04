import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const sourceDir = "assets/tree-sitter";
const distDir = "plugins/keep-coding/dist/grammars";
const manifest = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8"));
let total = 0;
for (const [name, expected] of Object.entries(manifest.files)) {
  for (const directory of [sourceDir, distDir]) {
    const file = path.join(directory, name);
    const bytes = await readFile(file);
    const info = await stat(file);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expected.sha256 || info.size !== expected.bytes) throw new Error(`tree-sitter asset mismatch: ${file}`);
    if (directory === distDir) total += info.size;
  }
}
if (total > 8_000_000) throw new Error(`tree-sitter asset budget exceeded: ${total}`);
console.log(`Tree-sitter assets verified (${total} bytes; budget 8000000).`);
