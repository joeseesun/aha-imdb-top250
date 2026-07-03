import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const rootDir = path.resolve(__dirname, "..");

export const config = {
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "https://movie.qiaomu.ai",
  legacyHosts: (process.env.LEGACY_HOSTS || "aha.qiaomu.ai").split(",").map((host) => host.trim()).filter(Boolean),
  storageDir: path.resolve(rootDir, process.env.STORAGE_DIR || "storage"),
  sessionSecret: process.env.SESSION_SECRET || "",
  omdbApiKey: process.env.OMDB_API_KEY || "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  editorialApiKey: process.env.EDITORIAL_LLM_API_KEY || process.env.ZAI_API_KEY || "",
  editorialBaseUrl: (process.env.EDITORIAL_LLM_BASE_URL || process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4").replace(/\/+$/, ""),
  editorialModel: process.env.EDITORIAL_LLM_MODEL || process.env.ZAI_MODEL || "glm-5.2"
};

export function runtimeStatus() {
  return {
    movieData: Boolean(config.omdbApiKey),
    translation: Boolean(config.deepseekApiKey),
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
