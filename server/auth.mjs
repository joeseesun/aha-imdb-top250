import crypto from "node:crypto";
import { config } from "./config.mjs";

const cookieName = "aha_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
const devSecret = "dev-only-aha-session-secret-change-in-production";

function activeSecret() {
  return config.sessionSecret || devSecret;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sign(payload) {
  return crypto.createHmac("sha256", activeSecret()).update(payload).digest("base64url");
}

function secureCookieSuffix() {
  return config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
}

export function createSessionCookie(session) {
  const expiresAt = Date.now() + sessionMaxAgeSeconds * 1000;
  const payload = Buffer.from(JSON.stringify({ ...session, expiresAt })).toString("base64url");
  return `${cookieName}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureCookieSuffix()}; Priority=High`;
}

export function clearSessionCookie() {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix()}; Priority=High`;
}

export function getSession(req) {
  const match = String(req.headers.cookie || "").match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) return null;
  const [payload, signature] = match[1].split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.expiresAt || parsed.expiresAt < Date.now()) return null;
    if (!parsed.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("base64url");
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return safeEqual(hash, expectedHash);
}

export function sameSiteOk(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "GET")) return true;
  const source = req.headers.origin || req.headers.referer || "";
  if (!source) return true;
  try {
    return new URL(source).origin === new URL(config.publicBaseUrl).origin;
  } catch {
    return false;
  }
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt
  };
}
