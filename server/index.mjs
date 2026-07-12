import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, requireProductionConfig, rootDir, runtimeStatus } from "./config.mjs";
import { clearSessionCookie, createSessionCookie, getSession, hashPassword, publicUser, sameSiteOk, verifyPassword } from "./auth.mjs";
import {
  createUser,
  getStatsForMovies,
  getUserByEmail,
  getUserById,
  getViewerReactions,
  listFavoriteIds,
  listLeaderboards,
  setFavorite,
  setViewerReaction
} from "./store.mjs";
import { fetchPoster, getMovie, listTopMovies, posterProxyPath, searchOmdb, topMovieTotal, topSeed } from "./movies.mjs";
import { renderAppHtml, robotsTxt, sitemapXml } from "./seo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"]
]);

function json(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

async function currentViewer(req) {
  const session = getSession(req);
  const user = session ? await getUserById(session.userId) : null;
  return { session, user };
}

// --- AI chat helpers (movie-context chat via DeepSeek, SSE streaming) ---

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// In-memory guest rate limiter: { ip: { count, windowStart } }
const guestChatLimits = new Map();
const GUEST_CHAT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const GUEST_CHAT_MAX = 10; // 10 messages per hour for guests

function checkGuestChatLimit(ip) {
  const now = Date.now();
  const entry = guestChatLimits.get(ip);
  if (!entry || now - entry.windowStart > GUEST_CHAT_WINDOW_MS) {
    guestChatLimits.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: GUEST_CHAT_MAX - 1 };
  }
  entry.count += 1;
  return { allowed: entry.count <= GUEST_CHAT_MAX, remaining: Math.max(0, GUEST_CHAT_MAX - entry.count) };
}

// Periodically purge stale entries to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of guestChatLimits) {
    if (now - entry.windowStart > GUEST_CHAT_WINDOW_MS * 2) guestChatLimits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function buildMovieContext(movie) {
  const parts = [];
  parts.push(`片名：${movie.title || ""}${movie.titleCn ? `（${movie.titleCn}）` : ""}`);
  if (movie.year) parts.push(`年份：${movie.year}`);
  if (movie.runtime) parts.push(`时长：${movie.runtime}`);
  if (movie.genre) parts.push(`类型：${movie.genre}`);
  if (movie.director) parts.push(`导演：${movie.director}`);
  if (movie.actors) parts.push(`主演：${movie.actors}`);
  if (movie.imdbRating) parts.push(`IMDb 评分：${movie.imdbRating}`);
  if (movie.synopsis?.text) parts.push(`剧情梗概：${movie.synopsis.text}`);
  if (movie.editorial?.hook) parts.push(`影评钩子：${movie.editorial.hook}`);
  if (movie.editorial?.intro) parts.push(`观影指南：${movie.editorial.intro}`);
  if (movie.cn?.awards || movie.awards) parts.push(`获奖：${movie.cn?.awards || movie.awards}`);
  return parts.join("\n");
}

function sanitizeChatTurns(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    .slice(-10);
}

async function streamMovieChat(res, movie, turns, { isGuest }) {
  const apiKey = config.deepseekApiKey;
  if (!apiKey) {
    writeSse(res, { type: "error", error: "AI 服务未配置" });
    return;
  }
  const context = buildMovieContext(movie);
  const payload = {
    model: config.deepseekModel,
    stream: true,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "system",
        content: [
          "你是一个嵌入电影指南网站的 AI 助手，用户正在浏览当前电影的详情页。",
          "你可以基于当前电影的信息回答用户关于这部电影的问题，也可以聊相关电影、导演风格、观影建议。",
          "用中文回答，简洁有判断，可以用 Markdown 列表。如果信息不足，坦诚说明，不要编造。",
          "不要剧透关键剧情转折和结局。"
        ].join("\n")
      },
      { role: "user", content: `当前电影信息：\n${context}` },
      { role: "assistant", content: "已读取当前电影信息，你可以问我任何关于这部电影的问题。" },
      ...turns
    ],
    max_tokens: isGuest ? 800 : 1500,
    temperature: 0.5
  };

  try {
    const upstream = await fetch(`${config.deepseekBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      writeSse(res, { type: "error", error: `AI 请求失败 (${upstream.status})` });
      return;
    }
    // Parse SSE chunks from DeepSeek and re-emit content deltas
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          writeSse(res, { type: "done" });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) writeSse(res, { type: "delta", text: delta });
        } catch {
          // ignore malformed lines
        }
      }
    }
    writeSse(res, { type: "done" });
  } catch (e) {
    writeSse(res, { type: "error", error: e?.name === "TimeoutError" ? "AI 响应超时" : "AI 服务暂时不可用" });
  }
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// General Top-250 chat (homepage): no specific movie, context is the chart.
async function streamGeneralChat(res, turns, { isGuest }) {
  const apiKey = config.deepseekApiKey;
  if (!apiKey) {
    writeSse(res, { type: "error", error: "AI 服务未配置" });
    return;
  }
  // Build a compact list of the top movies as context (rank + title).
  const all = topSeed();
  const chart = all
    .slice(0, 60)
    .map((m) => `${m.rank}. ${m.title}${m.titleCn ? `《${m.titleCn}》` : ""}${m.rating || m.imdbRating ? ` ${m.rating || m.imdbRating}` : ""}`)
    .join("\n");
  const payload = {
    model: config.deepseekModel,
    stream: true,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "system",
        content: [
          "你是一个嵌入电影指南网站的 AI 助手，用户正在浏览 IMDb Top 250 清单的首页。",
          "你可以帮用户从清单里挑片子（按心情、类型、时长、年代等），也可以聊某部电影、给观影建议。",
          "推荐时尽量给出榜单内的具体片名和推荐理由。用中文回答，简洁有判断，可以用 Markdown 列表。",
          "如果信息不足或不确定，坦诚说明，不要编造榜单上没有的片子。"
        ].join("\n")
      },
      { role: "user", content: `当前榜单（节选前 60 部）：\n${chart}` },
      { role: "assistant", content: "好的，我已经看了榜单，你可以告诉我你今晚的心情或想看的类型，我来挑。" },
      ...turns
    ],
    max_tokens: isGuest ? 800 : 1500,
    temperature: 0.5
  };

  try {
    const upstream = await fetch(`${config.deepseekBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)
    });
    if (!upstream.ok || !upstream.body) {
      writeSse(res, { type: "error", error: `AI 请求失败 (${upstream.status})` });
      return;
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") { writeSse(res, { type: "done" }); return; }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) writeSse(res, { type: "delta", text: delta });
        } catch { /* ignore */ }
      }
    }
    writeSse(res, { type: "done" });
  } catch (e) {
    writeSse(res, { type: "error", error: e?.name === "TimeoutError" ? "AI 响应超时" : "AI 服务暂时不可用" });
  }
}

function visitorActorId(visitorId) {
  const value = String(visitorId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(value)) return "";
  return `visitor:${value}`;
}

async function decorateMovies(movies) {
  const stats = await getStatsForMovies(movies.map((movie) => movie.imdbID));
  return movies.map((movie) => ({
    ...movie,
    stats: stats[movie.imdbID] || { favorites: 0, watched: 0, want: 0 }
  }));
}

// Slim projection for list/search endpoints: only the fields the grid needs.
// Drops editorial/research/cn-plot/etc. (~6KB -> ~1KB per movie) to cut first
// paint payload and let detail pages own the heavy content.
function slimMovie(movie) {
  return {
    imdbID: movie.imdbID,
    title: movie.title,
    titleCn: movie.titleCn,
    rank: movie.rank,
    year: movie.year,
    runtime: movie.runtime,
    genre: movie.genre,
    imdbRating: movie.imdbRating,
    poster: movie.poster,
    tags: movie.tags,
    cn: movie.cn ? {
      title: movie.cn.title,
      genre: movie.cn.genre,
      runtime: movie.cn.runtime
    } : undefined,
    chart: movie.chart ? {
      title: movie.chart.title,
      titleCn: movie.chart.titleCn,
      year: movie.chart.year,
      genre: movie.chart.genre,
      director: movie.chart.director,
      actors: movie.chart.actors
    } : undefined,
    editorial: movie.editorial ? { hook: movie.editorial.hook } : undefined,
    why: movie.why ? { headline: movie.why.headline } : undefined,
    stats: movie.stats || { favorites: 0, watched: 0, want: 0 }
  };
}

async function decorateMoviesSlim(movies) {
  const decorated = await decorateMovies(movies);
  return decorated.map(slimMovie);
}

async function hydrateLeaderboard(rows) {
  const movies = await Promise.all(rows.map(async (row) => ({
    ...row,
    movie: await getMovie(row.imdbID, { generateAi: false })
  })));
  return movies;
}

async function requireUser(req, res) {
  const { user } = await currentViewer(req);
  if (!user) {
    json(res, 401, { error: "unauthorized", message: "请先登录。" });
    return null;
  }
  return user;
}

async function handleApi(req, res, url) {
  if (!sameSiteOk(req)) {
    json(res, 403, { error: "csrf_check_failed", message: "请求来源校验失败，请刷新页面后重试。" });
    return;
  }

  const oldPosterMatch = url.pathname.match(/^\/api\/posters\/(tt\d+)\.jpg$/);
  if ((req.method === "GET" || req.method === "HEAD") && oldPosterMatch) {
    res.statusCode = 301;
    res.setHeader("Location", posterProxyPath(oldPosterMatch[1]));
    res.end();
    return;
  }

  const posterMatch = url.pathname.match(/^\/api\/posters\/(tt\d+)\.webp$/);
  if ((req.method === "GET" || req.method === "HEAD") && posterMatch) {
    try {
      const poster = await fetchPoster(posterMatch[1]);
      res.statusCode = 200;
      res.setHeader("Content-Type", poster.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? "" : poster.bytes);
    } catch {
      res.statusCode = 404;
      res.end();
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, missing: requireProductionConfig(), providers: runtimeStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const { user } = await currentViewer(req);
    const actorId = visitorActorId(url.searchParams.get("visitorId"));
    json(res, 200, {
      authenticated: Boolean(user),
      user: publicUser(user),
      favorites: user ? await listFavoriteIds(user.id) : [],
      reactions: actorId ? await getViewerReactions(actorId) : { watched: [], want: [] }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await parseBody(req);
    const password = String(body.password || "");
    if (password.length < 8) {
      json(res, 400, { error: "weak_password", message: "密码至少需要 8 位。" });
      return;
    }
    const passwordResult = hashPassword(password);
    const result = await createUser({ email: body.email, passwordHash: passwordResult.hash, passwordSalt: passwordResult.salt });
    if (result.error) {
      json(res, 400, result);
      return;
    }
    json(res, 201, { ok: true, user: publicUser(result.user), favorites: [] }, {
      "Set-Cookie": createSessionCookie({ userId: result.user.id })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await parseBody(req);
    const user = await getUserByEmail(body.email);
    if (!user || !verifyPassword(body.password || "", user.passwordSalt, user.passwordHash)) {
      json(res, 401, { error: "login_failed", message: "邮箱或密码不正确。" });
      return;
    }
    json(res, 200, { ok: true, user: publicUser(user), favorites: await listFavoriteIds(user.id) }, {
      "Set-Cookie": createSessionCookie({ userId: user.id })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/movies") {
    const query = url.searchParams.get("q")?.trim();
    const generateAi = url.searchParams.get("ai") === "1";
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const limit = Math.max(1, Number(url.searchParams.get("limit") || 24));
    const movies = query ? await searchOmdb(query) : await listTopMovies({ offset, limit, generateAi });
    const total = query ? movies.length : topMovieTotal();
    json(res, 200, {
      movies: await decorateMoviesSlim(movies),
      mode: query ? "search" : "top250",
      total,
      offset: query ? 0 : offset,
      limit: query ? movies.length : limit,
      hasMore: query ? false : offset + movies.length < total
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/leaderboards") {
    const boards = await listLeaderboards({ limit: Number(url.searchParams.get("limit") || 6) });
    json(res, 200, {
      watched: await hydrateLeaderboard(boards.watched),
      favorites: await hydrateLeaderboard(boards.favorites)
    });
    return;
  }

  const movieMatch = url.pathname.match(/^\/api\/movies\/(tt\d+)$/);
  if (req.method === "GET" && movieMatch) {
    const [movie] = await decorateMovies([await getMovie(movieMatch[1], { generateAi: false, enrichResearch: true })]);
    json(res, 200, { movie });
    return;
  }

  // General Top-250 chat (homepage): no specific movie.
  if (req.method === "POST" && url.pathname === "/api/chat") {
    const { user } = await currentViewer(req);
    const body = await parseBody(req);
    const turns = sanitizeChatTurns(body.messages);
    if (!turns.length || turns[turns.length - 1].role !== "user") {
      json(res, 400, { error: "需要至少一条用户消息" });
      return;
    }
    if (!user) {
      const ip = getClientIp(req);
      const { allowed, remaining } = checkGuestChatLimit(ip);
      if (!allowed) {
        res.setHeader("Retry-After", "3600");
        json(res, 429, { error: "guest_limit", message: "游客每小时限 10 条消息，登录后可无限对话。", remaining: 0 });
        return;
      }
      res.setHeader("X-Chat-Remaining", String(remaining));
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    await streamGeneralChat(res, turns, { isGuest: !user });
    res.end();
    return;
  }

  // AI chat: stream responses about the current movie.
  // Guests: rate-limited (8/hr). Logged-in: unlimited.
  const chatMatch = url.pathname.match(/^\/api\/movies\/(tt\d+)\/chat$/);
  if (req.method === "POST" && chatMatch) {
    const { user } = await currentViewer(req);
    const movie = await getMovie(chatMatch[1], { generateAi: false, enrichResearch: true });
    if (!movie) { json(res, 404, { error: "movie_not_found" }); return; }
    const body = await parseBody(req);
    const turns = sanitizeChatTurns(body.messages);
    if (!turns.length || turns[turns.length - 1].role !== "user") {
      json(res, 400, { error: "需要至少一条用户消息" });
      return;
    }
    // Guest rate limit
    if (!user) {
      const ip = getClientIp(req);
      const { allowed, remaining } = checkGuestChatLimit(ip);
      if (!allowed) {
        res.setHeader("Retry-After", "3600");
        json(res, 429, { error: "guest_limit", message: "游客每小时限 8 条消息，登录后可无限对话。", remaining: 0 });
        return;
      }
      res.setHeader("X-Chat-Remaining", String(remaining));
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    await streamMovieChat(res, movie, turns, { isGuest: !user });
    res.end();
    return;
  }

  const favoriteMatch = url.pathname.match(/^\/api\/favorites\/(tt\d+)$/);
  if (req.method === "POST" && favoriteMatch) {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await parseBody(req);
    const favorites = await setFavorite(user.id, favoriteMatch[1], Boolean(body.favorite));
    const stats = await getStatsForMovies([favoriteMatch[1]]);
    json(res, 200, { ok: true, favorites, stats: stats[favoriteMatch[1]] || { favorites: 0, watched: 0, want: 0 } });
    return;
  }

  const reactionMatch = url.pathname.match(/^\/api\/reactions\/(tt\d+)$/);
  if (req.method === "POST" && reactionMatch) {
    const body = await parseBody(req);
    const actorId = visitorActorId(body.visitorId);
    const result = await setViewerReaction(actorId, reactionMatch[1], body.status);
    if (result.error) {
      json(res, 400, result);
      return;
    }
    json(res, 200, {
      ok: true,
      reactions: await getViewerReactions(actorId),
      movieReactions: result.reactions,
      stats: result.stats
    });
    return;
  }

  json(res, 404, { error: "not_found" });
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  return path.join(publicDir, normalized === "/" ? "index.html" : normalized);
}

async function servePublic(req, res, url) {
  if (req.method === "GET" || req.method === "HEAD") {
    if (url.pathname === "/robots.txt") {
      res.setHeader("Content-Type", mimeTypes.get(".txt"));
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(req.method === "HEAD" ? "" : robotsTxt());
      return;
    }
    if (url.pathname === "/sitemap.xml") {
      res.setHeader("Content-Type", mimeTypes.get(".xml"));
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(req.method === "HEAD" ? "" : sitemapXml());
      return;
    }
    if (url.pathname === "/" || /^\/movie\/tt\d+\/?$/.test(url.pathname)) {
      res.setHeader("Content-Type", mimeTypes.get(".html"));
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? "" : await renderAppHtml(url.pathname));
      return;
    }
  }

  let filePath = safePublicPath(url.pathname);
  if (!existsSync(filePath)) filePath = path.join(publicDir, "index.html");
  const ext = path.extname(filePath);
  res.setHeader("Content-Type", mimeTypes.get(ext) || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function redirectLegacyHost(req, res, url) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const target = new URL(config.publicBaseUrl);
  if (!host || host === target.hostname || !config.legacyHosts.includes(host)) return false;
  target.pathname = url.pathname;
  target.search = url.search;
  res.statusCode = 301;
  res.setHeader("Location", target.toString());
  res.end();
  return true;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (redirectLegacyHost(req, res, url)) return;
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      await servePublic(req, res, url);
    } catch (error) {
      json(res, error.message === "invalid_json" ? 400 : 500, {
        error: "server_error",
        message: error.message
      });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(config.port, config.host, async () => {
    const pkg = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
    console.log(`${pkg.name} running at http://${config.host}:${config.port}`);
  });
}
