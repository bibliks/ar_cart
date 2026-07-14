import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.dirname(scriptRoot);
const projectRoot = path.dirname(prototypeRoot);
const publicRoot = path.join(prototypeRoot, "public");
const pagesRoot = path.join(projectRoot, "docs");
const assetsRoot = path.join(pagesRoot, "assets");

await Promise.all([
  mkdir(path.join(pagesRoot, "with-app"), { recursive: true }),
  mkdir(path.join(pagesRoot, "without-app"), { recursive: true }),
  mkdir(assetsRoot, { recursive: true }),
]);

const pagesApiBase = process.env.PAGES_API_BASE || "https://bibliks-sberkot-ar-api.onrender.com";
const indexHtml = (await readFile(path.join(publicRoot, "index.html"), "utf8")).replace(
  '<meta name="sberkot-api-base" content="" />',
  `<meta name="sberkot-api-base" content="${pagesApiBase}" />`,
);
await Promise.all([
  writeFile(path.join(pagesRoot, "index.html"), indexHtml, "utf8"),
  writeFile(path.join(pagesRoot, "with-app", "index.html"), indexHtml, "utf8"),
  writeFile(path.join(pagesRoot, "without-app", "index.html"), indexHtml, "utf8"),
  writeFile(path.join(pagesRoot, ".nojekyll"), ""),
  copyFile(path.join(publicRoot, "app.css"), path.join(pagesRoot, "app.css")),
  copyFile(path.join(publicRoot, "app.js"), path.join(pagesRoot, "app.js")),
  copyFile(path.join(projectRoot, "character.glb"), path.join(assetsRoot, "character.glb")),
  copyFile(path.join(projectRoot, "card.mind"), path.join(assetsRoot, "card.mind")),
  copyFile(path.join(projectRoot, "marker.png"), path.join(assetsRoot, "marker.png")),
]);

console.log(`GitHub Pages bundle created at ${pagesRoot}`);
