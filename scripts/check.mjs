import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "public/assets/qiaomu_reward_qr.png",
  "public/assets/qiaomu_wechat_public_account_qr.jpg",
  "server/index.mjs",
  "server/config.mjs",
  "server/auth.mjs",
  "server/store.mjs",
  "server/movies.mjs",
  "server/data/top250-imdb.json",
  "scripts/warm-cache.mjs"
];

for (const file of requiredFiles) {
  await access(path.join(root, file));
}

const scripts = [
  "server/index.mjs",
  "server/config.mjs",
  "server/auth.mjs",
  "server/store.mjs",
  "server/movies.mjs",
  "scripts/check.mjs",
  "scripts/warm-cache.mjs",
  "public/app.js"
];

for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", script], {
    cwd: root,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const html = await readFile(path.join(root, "public/index.html"), "utf8");
const css = await readFile(path.join(root, "public/styles.css"), "utf8");
const app = await readFile(path.join(root, "public/app.js"), "utf8");
const top250 = JSON.parse(await readFile(path.join(root, "server/data/top250-imdb.json"), "utf8"));

const checks = [
  ["Umami script", html.includes("https://umami.qiaomu.ai/script.js")],
  ["reward modal", html.includes("qiaomu_reward_qr.png")],
  ["follow modal", html.includes("qiaomu_wechat_public_account_qr.jpg")],
  ["Qiaomu directory", html.includes("https://tuijian.qiaomu.ai/")],
  ["auth UI", html.includes("authTemplate") && app.includes("/api/auth/register")],
  ["favorites UI", app.includes("/api/favorites/")],
  ["Top 250 seed count", top250.length === 250],
  ["Top 250 unique ids", new Set(top250.map((movie) => movie.imdbID)).size === 250],
  ["no provider strip", !html.includes("providerStrip") && !app.includes("renderProviders")],
  ["no public provider names", !/\b(OMDb|DeepSeek)\b/.test(`${html}\n${app}`)],
  ["no old top50 copy", !/Top50|Top 50|top50/.test(`${html}\n${app}`)],
  ["no banned generic copy", !`${html}\n${app}`.includes("值得看，因为它经得起时间和观众反复校验。")],
  ["no native alert", !/\b(alert|confirm|prompt)\s*\(/.test(app)],
  ["no title tooltip", !/\btitle=/.test(html)],
  ["no negative letter spacing", !/letter-spacing\s*:\s*-/.test(css)]
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  for (const [name] of failed) {
    console.error(`Check failed: ${name}`);
  }
  process.exit(1);
}

console.log("Static checks passed.");
