import crypto from "node:crypto";
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

function fingerprint(plainName) {
  const plainPath = path.join(outDir, plainName);
  const content = fs.readFileSync(plainPath);
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 10);
  const ext = path.extname(plainName);
  const hashedName = `${path.basename(plainName, ext)}.${hash}${ext}`;
  fs.copyFileSync(plainPath, path.join(outDir, hashedName));
  return hashedName;
}

const hashedJs = fingerprint("app.js");
const hashedCss = fingerprint("app.css");

const html = fs
  .readFileSync(path.join(root, "web", "index.html"), "utf8")
  .replace('src="app.js"', `src="${hashedJs}"`)
  .replace('href="app.css"', `href="${hashedCss}"`);
fs.writeFileSync(path.join(outDir, "index.html"), html);

fs.copyFileSync(path.join(root, "web", "manifest.webmanifest"), path.join(outDir, "manifest.webmanifest"));
fs.cpSync(path.join(root, "web", "icons"), path.join(outDir, "icons"), { recursive: true });
