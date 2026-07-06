import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";

const dataFile = path.join(config.storageDir, "movies.json");
let writeQueue = Promise.resolve();

// In-memory cache of the parsed data file. Reads hit memory instead of
// re-reading + re-parsing the whole JSON on every call (the list endpoint
// used to do this ~24x per request).
let memoryCache = null;
let memoryCachePromise = null;

function emptyData() {
  return {
    version: "1.1.0",
    movies: {},
    users: [],
    favorites: {},
    reactions: {
      watched: {},
      want: {}
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createId(prefix = "id") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function ensureStorage() {
  await fs.mkdir(config.storageDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify(emptyData(), null, 2));
    memoryCache = null;
  }
}

async function loadDataFromDisk() {
  await ensureStorage();
  const raw = await fs.readFile(dataFile, "utf8");
  const parsed = normalizeData(JSON.parse(raw));
  memoryCache = parsed;
  return parsed;
}

export async function readData() {
  if (memoryCache) return memoryCache;
  // Coalesce concurrent first-loads into a single disk read.
  if (!memoryCachePromise) {
    memoryCachePromise = loadDataFromDisk().finally(() => {
      memoryCachePromise = null;
    });
  }
  return memoryCachePromise;
}

export async function writeData(data) {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(config.storageDir, { recursive: true });
    const next = normalizeData(data);
    next.updatedAt = new Date().toISOString();
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.rename(tmp, dataFile);
    memoryCache = next;
  });
  return writeQueue;
}

async function updateData(mutator) {
  let result;
  writeQueue = writeQueue.then(async () => {
    await ensureStorage();
    const data = memoryCache || normalizeData(JSON.parse(await fs.readFile(dataFile, "utf8")));
    result = await mutator(data);
    data.updatedAt = new Date().toISOString();
    const normalized = normalizeData(data);
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(normalized, null, 2));
    await fs.rename(tmp, dataFile);
    memoryCache = normalized;
  });
  await writeQueue;
  return result;
}

function normalizeData(data) {
  return {
    version: data.version || "1.1.0",
    movies: data.movies && typeof data.movies === "object" ? data.movies : {},
    users: Array.isArray(data.users) ? data.users : [],
    favorites: data.favorites && typeof data.favorites === "object" ? data.favorites : {},
    reactions: normalizeReactions(data.reactions),
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString()
  };
}

function normalizeReactions(reactions) {
  const source = reactions && typeof reactions === "object" ? reactions : {};
  return {
    watched: normalizeReactionBucket(source.watched),
    want: normalizeReactionBucket(source.want)
  };
}

function normalizeReactionBucket(bucket) {
  if (!bucket || typeof bucket !== "object") return {};
  return Object.fromEntries(
    Object.entries(bucket).map(([imdbID, actorIds]) => [
      imdbID,
      [...new Set(Array.isArray(actorIds) ? actorIds.map(String).filter(Boolean) : [])]
    ])
  );
}

function normalizeActorId(actorId) {
  const value = String(actorId || "").trim();
  if (!/^[a-zA-Z0-9:_-]{8,96}$/.test(value)) return "";
  return value;
}

function countBucket(bucket = {}) {
  return Object.fromEntries(
    Object.entries(bucket).map(([imdbID, actorIds]) => [imdbID, Array.isArray(actorIds) ? actorIds.length : 0])
  );
}

function topCounts(counts, limit = 8) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([imdbID, count]) => ({ imdbID, count }));
}

export async function getCachedMovie(imdbID) {
  const data = await readData();
  return data.movies[imdbID] || null;
}

export async function saveCachedMovie(movie) {
  return updateData((data) => {
    const before = data.movies[movie.imdbID] || {};
    data.movies[movie.imdbID] = {
      ...before,
      ...movie,
      cachedAt: new Date().toISOString()
    };
    return data.movies[movie.imdbID];
  });
}

export async function createUser({ email, passwordHash, passwordSalt }) {
  return updateData((data) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return { error: "invalid_email", message: "请输入有效邮箱。" };
    }
    if (data.users.some((user) => user.email === normalizedEmail)) {
      return { error: "email_exists", message: "这个邮箱已经注册。" };
    }
    const now = new Date().toISOString();
    const user = {
      id: createId("user"),
      email: normalizedEmail,
      passwordHash,
      passwordSalt,
      createdAt: now,
      updatedAt: now
    };
    data.users.push(user);
    data.favorites[user.id] = [];
    return { user };
  });
}

export async function getUserByEmail(email) {
  const data = await readData();
  const normalizedEmail = normalizeEmail(email);
  return data.users.find((user) => user.email === normalizedEmail) || null;
}

export async function getUserById(userId) {
  const data = await readData();
  return data.users.find((user) => user.id === userId) || null;
}

export async function listFavoriteIds(userId) {
  const data = await readData();
  return Array.isArray(data.favorites[userId]) ? data.favorites[userId] : [];
}

export async function setFavorite(userId, imdbID, favorite) {
  return updateData((data) => {
    const current = new Set(Array.isArray(data.favorites[userId]) ? data.favorites[userId] : []);
    if (favorite) current.add(imdbID);
    else current.delete(imdbID);
    data.favorites[userId] = [...current];
    return data.favorites[userId];
  });
}

export async function getViewerReactions(actorId) {
  const normalizedActorId = normalizeActorId(actorId);
  if (!normalizedActorId) return { watched: [], want: [] };
  const data = await readData();
  return {
    watched: Object.entries(data.reactions.watched)
      .filter(([, actorIds]) => Array.isArray(actorIds) && actorIds.includes(normalizedActorId))
      .map(([imdbID]) => imdbID),
    want: Object.entries(data.reactions.want)
      .filter(([, actorIds]) => Array.isArray(actorIds) && actorIds.includes(normalizedActorId))
      .map(([imdbID]) => imdbID)
  };
}

export async function setViewerReaction(actorId, imdbID, status) {
  const normalizedActorId = normalizeActorId(actorId);
  if (!normalizedActorId) {
    return { error: "invalid_visitor", message: "无法识别当前浏览器，请刷新页面后重试。" };
  }
  const nextStatus = ["watched", "want", "none"].includes(status) ? status : "none";
  return updateData((data) => {
    for (const kind of ["watched", "want"]) {
      const current = new Set(Array.isArray(data.reactions[kind][imdbID]) ? data.reactions[kind][imdbID] : []);
      if (kind === nextStatus) current.add(normalizedActorId);
      else current.delete(normalizedActorId);
      data.reactions[kind][imdbID] = [...current];
      if (data.reactions[kind][imdbID].length === 0) delete data.reactions[kind][imdbID];
    }
    return {
      reactions: {
        watched: data.reactions.watched[imdbID]?.includes(normalizedActorId) || false,
        want: data.reactions.want[imdbID]?.includes(normalizedActorId) || false
      },
      stats: getStatsForMovieFromData(data, imdbID)
    };
  });
}

function favoriteCountsFromData(data) {
  const counts = {};
  for (const favoriteIds of Object.values(data.favorites)) {
    if (!Array.isArray(favoriteIds)) continue;
    for (const imdbID of favoriteIds) {
      counts[imdbID] = (counts[imdbID] || 0) + 1;
    }
  }
  return counts;
}

function getStatsForMovieFromData(data, imdbID) {
  return {
    favorites: favoriteCountsFromData(data)[imdbID] || 0,
    watched: data.reactions.watched[imdbID]?.length || 0,
    want: data.reactions.want[imdbID]?.length || 0
  };
}

export async function getStatsForMovies(imdbIDs) {
  const ids = [...new Set((imdbIDs || []).filter(Boolean))];
  const data = await readData();
  const favoriteCounts = favoriteCountsFromData(data);
  const watchedCounts = countBucket(data.reactions.watched);
  const wantCounts = countBucket(data.reactions.want);
  return Object.fromEntries(ids.map((imdbID) => [
    imdbID,
    {
      favorites: favoriteCounts[imdbID] || 0,
      watched: watchedCounts[imdbID] || 0,
      want: wantCounts[imdbID] || 0
    }
  ]));
}

export async function listLeaderboards({ limit = 8 } = {}) {
  const data = await readData();
  return {
    watched: topCounts(countBucket(data.reactions.watched), limit),
    favorites: topCounts(favoriteCountsFromData(data), limit)
  };
}
