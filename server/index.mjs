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
import { fetchPoster, getMovie, listTopMovies, posterProxyPath, searchOmdb, topMovieTotal } from "./movies.mjs";
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
      movies: await decorateMovies(movies),
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
