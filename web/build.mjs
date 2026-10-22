// Builds the deploy tree (ES modules served as-is, deps from esm.sh) and a bundled test page.
import fs from "node:fs";
import crypto from "node:crypto";
import * as esbuild from "esbuild";

const SRC = "src/app", OUT = "deploy";
const MODS = ["app", "common", "login", "list", "detail", "recon", "intro", "sync", "expenses"];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT + "/app", { recursive: true });

const css = fs.readFileSync(SRC + "/base.css", "utf8") + "\n" + fs.readFileSync(SRC + "/grid.css", "utf8");
fs.writeFileSync(OUT + "/app/app.css", css);
const h = crypto.createHash("md5");
h.update(css);
for (const m of MODS) {
  const js = fs.readFileSync(`${SRC}/${m}.js`, "utf8");
  fs.writeFileSync(`${OUT}/app/${m}.js`, js);
  h.update(js);
}
const v = h.digest("hex").slice(0, 8);
const importmap = { imports: {
  react: "https://esm.sh/react@18.3.1",
  "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
  htm: "https://esm.sh/htm@3.1.1",
  "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2.45.4",
} };
fs.writeFileSync(OUT + "/index.html", `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TVPS Event Expenses</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/app/app.css?v=${v}">
<script type="importmap">${JSON.stringify(importmap)}</script>
</head><body><div id="root"></div>
<script type="module" src="/app/app.js?v=${v}"></script>
</body></html>
`);
fs.writeFileSync(OUT + "/vercel.json", JSON.stringify({
  cleanUrls: true,
  headers: [
    { source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },
    { source: "/app/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
  ],
}));

// Test bundle: same source, Supabase swapped for an in-memory mock.
await esbuild.build({
  entryPoints: [SRC + "/app.js"], bundle: true, format: "esm", outfile: "test/dist.js",
  alias: { "@supabase/supabase-js": "./test/mock-supabase.js" }, logLevel: "warning",
});
fs.writeFileSync("test/index.html", `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module" src="./dist.js"></script></body></html>`);
console.log("built", v);
