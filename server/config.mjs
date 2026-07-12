import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const rootDir = path.resolve(__dirname, "..");
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_OFFICIAL_BASE_URL = "https://api.deepseek.com";

function deepseekBaseUrl() {
  const raw = (process.env.DEEPSEEK_BASE_URL || DEEPSEEK_OFFICIAL_BASE_URL).replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.origin !== DEEPSEEK_OFFICIAL_BASE_URL || url.pathname !== "/") {
    throw new Error(`DEEPSEEK_BASE_URL must be ${DEEPSEEK_OFFICIAL_BASE_URL}`);
  }
  return DEEPSEEK_OFFICIAL_BASE_URL;
}

export const config = {
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "https://movie.qiaomu.ai",
  legacyHosts: (process.env.LEGACY_HOSTS || "aha.qiaomu.ai").split(",").map((host) => host.trim()).filter(Boolean),
  storageDir: path.resolve(rootDir, process.env.STORAGE_DIR || "storage"),
  sessionSecret: process.env.SESSION_SECRET || "",
  omdbApiKey: process.env.OMDB_API_KEY || "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: deepseekBaseUrl(),
  deepseekModel: DEEPSEEK_FLASH_MODEL,
  editorialApiKey: process.env.EDITORIAL_LLM_API_KEY || process.env.ZAI_API_KEY || "",
  editorialBaseUrl: (process.env.EDITORIAL_LLM_BASE_URL || process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4").replace(/\/+$/, ""),
  editorialModel: process.env.EDITORIAL_LLM_MODEL || process.env.ZAI_MODEL || "glm-5.2"
};

export function runtimeStatus() {
  return {
    movieData: Boolean(config.omdbApiKey),
    translation: Boolean(config.deepseekApiKey),
    deepseekModel: config.deepseekModel,
    editorial: Boolean(config.editorialApiKey),
    storage: Boolean(config.storageDir),
    publicBaseUrl: config.publicBaseUrl
  };
}

export function requireProductionConfig() {
  const missing = [];
  if (!config.omdbApiKey) missing.push("OMDB_API_KEY");
  if (!config.sessionSecret || config.sessionSecret.length < 24) missing.push("SESSION_SECRET");
  return missing;
}
