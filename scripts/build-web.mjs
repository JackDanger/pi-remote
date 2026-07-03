import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "web", "dist");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, "web", "src", "app.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(outDir, "app.js"),
});

fs.copyFileSync(path.join(root, "web", "src", "styles.css"), path.join(outDir, "app.css"));
fs.copyFileSync(path.join(root, "web", "index.html"), path.join(outDir, "index.html"));
fs.copyFileSync(path.join(root, "web", "manifest.webmanifest"), path.join(outDir, "manifest.webmanifest"));
fs.cpSync(path.join(root, "web", "icons"), path.join(outDir, "icons"), { recursive: true });
