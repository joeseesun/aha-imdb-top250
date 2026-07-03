import top250 from "./data/top250-imdb.json" with { type: "json" };
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config, runtimeStatus } from "./config.mjs";
import { getCachedMovie, saveCachedMovie } from "./store.mjs";

const OMDB_BASE = "https://www.omdbapi.com/";
const IMG_BASE = "https://img.omdbapi.com/";
const CACHE_MAX_MS = 1000 * 60 * 60 * 24 * 7;
const AI_CACHE_MAX_MS = 1000 * 60 * 60 * 24 * 120;
const OLD_RULE_PROVIDER = "规则" + "兜底";
const OLD_GENERIC_HEADLINE = ["值得看", "因为它经得起时间和观众反复校验。"].join("，");
const OLD_COORDINATE_FRAGMENT = ["清晰的", "口碑坐标"].join("");
const GENERIC_EDITORIAL_FRAGMENTS = [
  "经得起时间",
  "经得起反复",
  "高分所以值得",
  "不容错过",
  "必看经典",
  "经典之作",
  "伟大作品"
];
const SPOILER_EDITORIAL_FRAGMENTS = [
  "凶手",
  "真凶",
  "幕后黑手",
  "真正身份",
  "原来是",
  "结局",
  "最后场景",
  "逃脱方式",
  "死亡归宿",
  "海报",
  "石锤"
];
const DUBIOUS_EDITORIAL_FRAGMENTS = [
  "长期写作",
  "一贯",
  "通常",
  "少有的",
  "prison fiction"
];
const TOP_TOTAL = top250.length;
const RESEARCH_CACHE_MAX_MS = 1000 * 60 * 60 * 24 * 30;
const RESEARCH_VERSION = 5;
const EDITORIAL_CACHE_MAX_MS = 1000 * 60 * 60 * 24 * 180;
const EDITORIAL_VERSION = 7;
const DETAIL_CACHE_MAX_MS = 1000 * 60 * 60 * 24 * 120;
const DETAIL_VERSION = 4;
const POSTER_CACHE_DIR = path.join(config.storageDir, "posters");
const POSTER_WIDTH = 360;
const POSTER_QUALITY = 72;

function clean(value) {
  if (!value || value === "N/A") return "";
  return String(value).trim();
}

function splitList(value) {
  return clean(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function firstSentence(value, maxLength = 96) {
  const text = clean(value).replace(/\s+/g, " ");
  if (!text) return "";
  const sentence = text.match(/^(.+?[.!?。！？])\s/)?.[1] || text;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1)}…` : sentence;
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function chineseGenre(value) {
  const map = new Map([
    ["Action", "动作"],
    ["Adventure", "冒险"],
    ["Animation", "动画"],
    ["Biography", "传记"],
    ["Comedy", "喜剧"],
    ["Crime", "犯罪"],
    ["Drama", "剧情"],
    ["Family", "家庭"],
    ["Fantasy", "奇幻"],
    ["History", "历史"],
    ["Horror", "恐怖"],
    ["Music", "音乐"],
    ["Mystery", "悬疑"],
    ["Romance", "爱情"],
    ["Sci-Fi", "科幻"],
    ["Sport", "运动"],
    ["Thriller", "惊悚"],
    ["War", "战争"],
    ["Western", "西部"]
  ]);
  const genres = splitList(value).map((item) => map.get(item) || item).filter(Boolean);
  return genres.length ? genres.join("、") : "";
}

function compactPeople(value, max = 2) {
  return splitList(value).slice(0, max).join("、");
}

function translateAwards(value) {
  const text = clean(value);
  if (!text) return "";
  const wonOscars = text.match(/Won (\d+) Oscars?/i);
  const nominatedOscars = text.match(/Nominated for (\d+) Oscars?/i);
  const totals = text.match(/(\d+) wins? & (\d+) nominations? total/i);
  const parts = [];
  if (wonOscars) parts.push(`获得 ${wonOscars[1]} 项奥斯卡`);
  if (nominatedOscars) parts.push(`获 ${nominatedOscars[1]} 项奥斯卡提名`);
  if (totals) parts.push(`共 ${totals[1]} 次获奖、${totals[2]} 次提名`);
  return parts.length ? `${parts.join("；")}。` : text;
}

function bestRating(movie) {
  if (movie.imdbRating) return `IMDb ${movie.imdbRating}`;
  const rating = Array.isArray(movie.ratings) ? movie.ratings[0] : null;
  return rating?.Value ? `${rating.Source} ${rating.Value}` : "";
}

function concreteHeadline(movie, genre, director, rating) {
  const premise = firstSentence(movie.plot, 80);
  const actors = compactPeople(movie.actors, 2);
  if (hasCjk(premise) && director) return `${director} 把“${premise}”压进${genre}的叙事里，入口清楚，余味不轻。`;
  if (director && actors) return `${director} 和 ${actors} 的组合，让这部${genre}片先从人物关系进入。`;
  if (director && movie.awards) return `${director} 的创作线索，加上“${movie.awards}”这组奖项记录，构成它的第一层看点。`;
  if (director && rating) return `${director} 的作者痕迹和 ${rating} 的观众评分，让它在同类型里有明确位置。`;
  return `它在${genre}类型里留下了足够鲜明的创作痕迹。`;
}

function chartFromRow(row) {
  if (!row) return null;
  return {
    rank: row.rank,
    title: row.title,
    titleCn: row.titleCn,
    year: row.year,
    imdbRating: row.imdbRating,
    runtime: row.runtime,
    genre: row.genre,
    director: row.director,
    actors: row.actors,
    plot: row.plot,
    awards: row.awards,
    country: row.country,
    language: row.language
  };
}

function findChartRow(imdbID) {
  return top250.find((row) => row.imdbID === imdbID) || null;
}

function mergeChart(movie, chart) {
  if (!chart) return movie;
  return {
    ...movie,
    rank: chart.rank || movie.rank,
    titleCn: clean(movie.titleCn) || clean(chart.titleCn),
    chart
  };
}

function isFresh(iso, maxMs = CACHE_MAX_MS) {
  if (!iso) return false;
  const timestamp = new Date(iso).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxMs;
}

function privatePosterUrl(imdbID) {
  if (!config.omdbApiKey || !imdbID) return "";
  const params = new URLSearchParams({ i: imdbID, h: "500", apikey: config.omdbApiKey });
  return `${IMG_BASE}?${params}`;
}

export function posterProxyPath(imdbID) {
  return imdbID ? `/api/posters/${imdbID}.webp` : "";
}

async function fetchImageBytes(url, source) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000),
    headers: {
      Accept: "image/*",
      "User-Agent": "QiaomuMovieGuide/1.0 https://movie.qiaomu.ai"
    }
  });
  if (!response.ok) throw new Error(`${source} Poster HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchPoster(imdbID) {
  const cachedPath = path.join(POSTER_CACHE_DIR, `${imdbID}.webp`);
  try {
    return {
      contentType: "image/webp",
      bytes: await fs.readFile(cachedPath),
      cached: true
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const url = privatePosterUrl(imdbID);
  if (!url) throw new Error("OMDB_API_KEY is not configured");
  let sourceBytes;
  try {
    sourceBytes = await fetchImageBytes(url, "OMDb");
  } catch (error) {
    const cachedMovie = await getCachedMovie(imdbID);
    const fallbackUrl = clean(cachedMovie?.posterOriginal);
    if (!/^https?:\/\//.test(fallbackUrl)) throw error;
    sourceBytes = await fetchImageBytes(fallbackUrl, "Original");
  }
  const bytes = await sharp(sourceBytes)
    .resize({ width: POSTER_WIDTH, withoutEnlargement: true })
    .webp({ quality: POSTER_QUALITY, effort: 4 })
    .toBuffer();
  await fs.mkdir(POSTER_CACHE_DIR, { recursive: true });
  await fs.writeFile(cachedPath, bytes);
  return {
    contentType: "image/webp",
    bytes,
    cached: false
  };
}

function formatMovie(raw, rank = null) {
  const ratings = Array.isArray(raw.Ratings) ? raw.Ratings : [];
  return {
    imdbID: raw.imdbID,
    rank: rank || raw.rank || null,
    title: clean(raw.Title),
    titleCn: clean(raw.titleCn || raw.TitleCn || raw.zhTitle || raw.titleZh),
    year: clean(raw.Year),
    rated: clean(raw.Rated),
    released: clean(raw.Released),
    runtime: clean(raw.Runtime),
    genre: clean(raw.Genre),
    director: clean(raw.Director),
    writer: clean(raw.Writer),
    actors: clean(raw.Actors),
    plot: clean(raw.Plot),
    language: clean(raw.Language),
    country: clean(raw.Country),
    awards: clean(raw.Awards),
    poster: posterProxyPath(raw.imdbID),
    posterOriginal: clean(raw.Poster),
    metascore: clean(raw.Metascore),
    imdbRating: clean(raw.imdbRating),
    imdbVotes: clean(raw.imdbVotes),
    type: clean(raw.Type),
    dvd: clean(raw.DVD),
    boxOffice: clean(raw.BoxOffice),
    production: clean(raw.Production),
    website: clean(raw.Website),
    ratings,
    tags: splitList(raw.Genre).slice(0, 3),
    omdbFetchedAt: new Date().toISOString()
  };
}

async function fetchJson(url, source) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000),
    headers: {
      Accept: "application/json",
      "User-Agent": "QiaomuMovieGuide/1.0 https://movie.qiaomu.ai"
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
  if (!response.ok || data.Response === "False") {
    throw new Error(data.Error || `${source} HTTP ${response.status}`);
  }
  return data;
}

export async function fetchOmdbById(imdbID) {
  if (!config.omdbApiKey) {
    throw new Error("OMDB_API_KEY is not configured");
  }
  const params = new URLSearchParams({ i: imdbID, plot: "full", apikey: config.omdbApiKey });
  return formatMovie(await fetchJson(`${OMDB_BASE}?${params}`, "OMDb"));
}

export async function searchOmdb(query) {
  if (!config.omdbApiKey) {
    throw new Error("OMDB_API_KEY is not configured");
  }
  const params = new URLSearchParams({ s: query, type: "movie", apikey: config.omdbApiKey });
  const data = await fetchJson(`${OMDB_BASE}?${params}`, "OMDb");
  const results = Array.isArray(data.Search) ? data.Search.slice(0, 10) : [];
  const movies = [];
  for (const item of results) {
    try {
      movies.push(await getMovie(item.imdbID, { generateAi: false }));
    } catch {
      movies.push({
        imdbID: item.imdbID,
        title: clean(item.Title),
        year: clean(item.Year),
        poster: posterProxyPath(item.imdbID),
        posterOriginal: clean(item.Poster)
      });
    }
  }
  return movies;
}

function fallbackChinese(movie, error = "") {
  const title = clean(movie.titleCn) || clean(movie.chart?.titleCn) || movie.title;
  const genre = chineseGenre(movie.genre) || movie.genre || "电影";
  const director = compactPeople(movie.director, 2);
  const actors = compactPeople(movie.actors, 3);
  const premise = firstSentence(movie.plot);
  const rating = bestRating(movie);
  const awards = translateAwards(movie.awards);
  const parts = [
    hasCjk(premise) ? `故事入口集中在“${premise}”这一组矛盾上。` : "",
    director ? `${director} 的导演位置很关键${actors ? `，演员入口可以先看 ${actors}` : ""}。` : "",
    movie.genre ? `类型是${genre}${movie.runtime ? `，片长 ${movie.runtime}` : ""}，适合按这个节奏预期进入。` : "",
    awards ? `奖项记录显示它不只停留在影迷圈：${awards}` : "",
    rating ? `${rating}${movie.imdbVotes ? `、${movie.imdbVotes} 个评分` : ""}，说明它有足够大的观众样本。` : ""
  ].filter(Boolean);
  const generatedAt = new Date().toISOString();
  return {
    cn: {
      title,
      plot: movie.plot,
      genre,
      rated: movie.rated,
      released: movie.released,
      runtime: movie.runtime,
      director: movie.director,
      writer: movie.writer,
      actors: movie.actors,
      language: movie.language,
      country: movie.country,
      awards,
      boxOffice: movie.boxOffice,
      production: movie.production,
      generatedAt,
      fallback: true,
      error: error || ""
    },
    why: {
      headline: concreteHeadline(movie, genre, director, rating),
      points: parts.slice(0, 4),
      mood: genre,
      generatedAt,
      fallback: true,
      error: error || ""
    }
  };
}

function normalizeChinesePayload(parsed, movie) {
  const fallback = fallbackChinese(movie);
  const cn = parsed?.cn && typeof parsed.cn === "object" ? parsed.cn : {};
  const why = parsed?.why && typeof parsed.why === "object" ? parsed.why : {};
  const generatedAt = new Date().toISOString();
  return {
    cn: {
      title: clean(cn.title) || fallback.cn.title,
      plot: clean(cn.plot) || fallback.cn.plot,
      genre: clean(cn.genre) || fallback.cn.genre,
      rated: clean(cn.rated) || fallback.cn.rated,
      released: clean(cn.released) || fallback.cn.released,
      runtime: clean(cn.runtime) || fallback.cn.runtime,
      director: clean(cn.director) || fallback.cn.director,
      writer: clean(cn.writer) || fallback.cn.writer,
      actors: clean(cn.actors) || fallback.cn.actors,
      language: clean(cn.language) || fallback.cn.language,
      country: clean(cn.country) || fallback.cn.country,
      awards: clean(cn.awards) || fallback.cn.awards,
      boxOffice: clean(cn.boxOffice) || fallback.cn.boxOffice,
      production: clean(cn.production) || fallback.cn.production,
      generatedAt,
      fallback: false
    },
    why: {
      headline: clean(why.headline) || fallback.why.headline,
      points: Array.isArray(why.points) ? why.points.map(clean).filter(Boolean).slice(0, 4) : fallback.why.points,
      mood: clean(why.mood) || fallback.why.mood,
      generatedAt,
      fallback: false
    }
  };
}

function normalizeTextArray(value, maxItems = 4, minLength = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .map(clean)
    .filter((item) => item.length >= minLength)
    .slice(0, maxItems);
}

function migrateWhyOnly(movie) {
  if (movie.cn && movie.why) return { cn: movie.cn, why: movie.why };
  if (!movie.why) return null;
  return {
    cn: fallbackChinese(movie).cn,
    why: movie.why
  };
}

function hasFreshAi(movie) {
  const payload = migrateWhyOnly(movie);
  if (!payload) return false;
  if (payload.cn?.error || payload.why?.error) return false;
  if (payload.cn?.fallback || payload.why?.fallback) return false;
  return isFresh(payload.cn?.generatedAt || payload.why?.generatedAt, AI_CACHE_MAX_MS);
}

function hasOldGenericFallback(movie) {
  const headline = clean(movie?.why?.headline);
  return movie?.why?.generatedBy === OLD_RULE_PROVIDER
    || headline === OLD_GENERIC_HEADLINE
    || headline.includes(OLD_COORDINATE_FRAGMENT)
    || (movie?.why?.generatedBy === "OMDb 资料兜底" && (headline.includes(" 年的") || headline.includes(" / ")));
}

function buildPrompt(movie) {
  return [
    "你是乔木电影网站的中文电影编辑。请只基于下面的 OMDb 资料，把电影资料整理为自然中文，并解释为什么值得看。",
    "要求：不要编造 OMDb 没有的事实；不要剧透关键反转；专有名词可保留英文；输出严格 JSON，不要 Markdown。",
    "JSON 结构：",
    "{",
    "  \"cn\": {\"title\":\"中文片名或常用译名，不确定则保留原名\", \"plot\":\"中文剧情简介\", \"genre\":\"中文类型\", \"rated\":\"中文分级说明\", \"released\":\"中文上映信息\", \"runtime\":\"中文片长\", \"director\":\"中文导演字段\", \"writer\":\"中文编剧字段\", \"actors\":\"中文主演字段\", \"language\":\"中文语言字段\", \"country\":\"中文国家地区字段\", \"awards\":\"中文奖项字段\", \"boxOffice\":\"中文票房字段\", \"production\":\"中文制作发行字段\"},",
    "  \"why\": {\"headline\":\"一句中文推荐语\", \"points\":[\"3-4 条不剧透的观看理由\"], \"mood\":\"适合什么观影心情\"}",
    "}",
    "",
    JSON.stringify({
      imdbID: movie.imdbID,
      title: movie.title,
      titleCn: movie.titleCn || movie.chart?.titleCn || "",
      year: movie.year,
      rated: movie.rated,
      released: movie.released,
      runtime: movie.runtime,
      genre: movie.genre,
      director: movie.director,
      writer: movie.writer,
      actors: movie.actors,
      plot: movie.plot,
      language: movie.language,
      country: movie.country,
      awards: movie.awards,
      boxOffice: movie.boxOffice,
      production: movie.production,
      imdbRating: movie.imdbRating,
      metascore: movie.metascore,
      ratings: movie.ratings
    })
  ].join("\n");
}

async function generateChineseWithDeepSeek(movie) {
  if (!config.deepseekApiKey) return fallbackChinese(movie);
  const response = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(25000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.deepseekApiKey}`
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你只输出有效 JSON，不输出 Markdown。" },
        { role: "user", content: buildPrompt(movie) }
      ],
      temperature: 0.35,
      max_tokens: 1200
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `DeepSeek HTTP ${response.status}`);
  }
  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeChinesePayload(JSON.parse(content), movie);
}

function attachChinese(movie, payload) {
  return {
    ...movie,
    cn: payload.cn,
    why: payload.why
  };
}

function displayMovieTitle(movie) {
  const cnTitle = clean(movie.cn?.title);
  if (hasCjk(cnTitle)) return cnTitle;
  return clean(movie.titleCn) || clean(movie.chart?.titleCn) || clean(movie.title);
}

function buildEditorialPrompt(movie) {
  const title = displayMovieTitle(movie);
  const original = clean(movie.title);
  return [
    "你是乔木电影清单的中文电影编辑。你的任务不是复述剧情，也不是写泛泛好评，而是给一个普通观众真正有增量的观影入口。",
    "请基于电影公共知识和下方基础资料来写；事实性剧情入口、主创、年份以基础资料为锚点。不要输出技术说明，不要提模型，不要说“高分所以值得看”。",
    "约束：假设用户还没看过；不剧透结局、死亡归宿、凶手身份、关键反转、逃脱方式、关键道具用途或最后场景；不要虚构具体奖项或幕后事实；不要使用你不能确定的人名、理论名、学派名、冷僻术语或装饰性名词；不要做“某导演/作者长期如何、通常如何、少有如何”这类宏观归纳；除片名、人名外尽量不用英文术语。不确定就写成可观察的叙事/表演/影像事实。",
    "每句话都要能帮助用户决定是否看、看什么、怎么看；不要写空泛判断，不要写“经典”“伟大”“经得起检验”这类无增量句子。",
    "只输出严格 JSON，不要 Markdown，不要多余解释。",
    "JSON 结构：",
    "{",
    "  \"hook\":\"一句抓人的具体推荐，不超过 70 字\",",
    "  \"intro\":\"120-180 字，说明这部片真正的观看入口和独特价值\",",
    "  \"watchPoints\":[\"4 条具体观看角度，每条 45-90 字\"],",
    "  \"contextNotes\":[\"2-3 条可公开核验的发行、改编、类型位置或观众传播语境，不写创作者画像\"],",
    "  \"craftNotes\":[\"2-3 条表演、摄影、剪辑、声音、叙事结构等创作看点\"],",
    "  \"bestFor\":\"适合什么样的观众或观影心情\",",
    "  \"caution\":\"什么观众可能不适合，具体说明，不要劝退式空话\",",
    "  \"rewatchPoint\":\"二刷时可以回看的一个非剧透观察方向，不要点出关键道具、结局、反转或解谜线索\"",
    "}",
    "",
    JSON.stringify({
      movieName: title,
      originalTitle: original !== title ? original : "",
      year: movie.chart?.year || movie.year || "",
      director: movie.director || movie.chart?.director || "",
      writer: movie.writer || "",
      actors: movie.actors || movie.chart?.actors || "",
      genre: movie.genre || movie.chart?.genre || "",
      plot: movie.plot || movie.chart?.plot || ""
    })
  ].join("\n");
}

function normalizeEditorialPayload(parsed, movie) {
  const title = displayMovieTitle(movie);
  const watchPoints = normalizeTextArray(parsed?.watchPoints, 4);
  const contextNotes = normalizeTextArray(parsed?.contextNotes, 3);
  const craftNotes = normalizeTextArray(parsed?.craftNotes, 3);
  const hook = clean(parsed?.hook);
  const intro = clean(parsed?.intro);
  if (!hook || !intro || watchPoints.length < 3) {
    throw new Error("Editorial payload is incomplete");
  }
  const allText = [hook, intro, ...watchPoints, ...contextNotes, ...craftNotes, parsed?.bestFor, parsed?.caution, parsed?.rewatchPoint]
    .map(clean)
    .join("\n");
  if (GENERIC_EDITORIAL_FRAGMENTS.some((fragment) => allText.includes(fragment))) {
    throw new Error("Editorial payload contains generic filler");
  }
  if (SPOILER_EDITORIAL_FRAGMENTS.some((fragment) => allText.includes(fragment))) {
    throw new Error("Editorial payload contains spoiler fragments");
  }
  if (DUBIOUS_EDITORIAL_FRAGMENTS.some((fragment) => allText.includes(fragment))) {
    throw new Error("Editorial payload contains dubious broad claims");
  }
  return {
    title: `《${title}》真正值得看的地方`,
    hook,
    intro,
    watchPoints,
    contextNotes,
    craftNotes,
    bestFor: clean(parsed?.bestFor),
    caution: clean(parsed?.caution),
    rewatchPoint: clean(parsed?.rewatchPoint),
    version: EDITORIAL_VERSION,
    generatedAt: new Date().toISOString()
  };
}

async function generateEditorialWithGlm(movie) {
  if (!config.editorialApiKey) return null;
  const response = await fetch(`${config.editorialBaseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${config.editorialApiKey}`
    },
    body: JSON.stringify({
      model: config.editorialModel,
      thinking: { type: "disabled" },
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你只输出有效 JSON，不输出 Markdown。" },
        { role: "user", content: buildEditorialPrompt(movie) }
      ],
      temperature: 0.5,
      max_tokens: 2200
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Editorial model HTTP ${response.status}`);
  }
  const content = clean(data?.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("Editorial model returned empty content");
  }
  return normalizeEditorialPayload(JSON.parse(content), movie);
}

function editorialIsFresh(movie) {
  return movie.editorial?.version === EDITORIAL_VERSION
    && movie.editorial?.generatedAt
    && isFresh(movie.editorial.generatedAt, EDITORIAL_CACHE_MAX_MS)
    && clean(movie.editorial.hook)
    && normalizeTextArray(movie.editorial.watchPoints, 4).length >= 3;
}

async function ensureEditorial(movie) {
  if (editorialIsFresh(movie)) return movie.editorial;
  try {
    return await generateEditorialWithGlm(movie);
  } catch {
    return editorialIsFresh(movie) ? movie.editorial : null;
  }
}

function intersect(left, right) {
  const rightSet = new Set(right.map((item) => item.toLowerCase()));
  return left.filter((item) => rightSet.has(item.toLowerCase()));
}

function sentenceSubject(value, maxLength = 88) {
  const sentence = firstSentence(value, maxLength);
  return sentence.replace(/\.$/, "");
}

function publicRatingSource(source) {
  const map = new Map([
    ["Internet Movie Database", "IMDb"],
    ["Rotten Tomatoes", "烂番茄"],
    ["Metacritic", "Metacritic"]
  ]);
  return map.get(source) || source;
}

function ratingsForDisplay(movie) {
  const ratings = Array.isArray(movie.ratings) ? movie.ratings : [];
  const mapped = ratings.map((rating) => ({
    source: publicRatingSource(clean(rating.Source)),
    value: clean(rating.Value)
  })).filter((rating) => rating.source && rating.value);
  if (!mapped.length && movie.imdbRating) {
    mapped.push({ source: "IMDb", value: `${movie.imdbRating}/10` });
  }
  return mapped;
}

function displayYearForText(movie) {
  return movie.chart?.year || movie.year ? `${movie.chart?.year || movie.year} 年` : "一部";
}

function genrePhrase(value) {
  return chineseGenre(Array.isArray(value) ? value.join(", ") : value) || clean(Array.isArray(value) ? value.join("、") : value);
}

async function buildSummaryAgent(movie) {
  const title = displayMovieTitle(movie);
  const translatedPlot = hasCjk(movie.cn?.plot) ? clean(movie.cn?.plot) : "";
  const director = compactPeople(movie.cn?.director || movie.director, 2);
  const actors = compactPeople(movie.cn?.actors || movie.actors, 3);
  const genre = movie.cn?.genre || chineseGenre(movie.genre) || movie.genre;
  const body = translatedPlot
    ? `《${title}》由 ${director || "主创团队"} 执导，故事围绕 ${sentenceSubject(translatedPlot, 120)} 展开。它的类型入口是${genre || "剧情"}，适合先看人物选择，再看结构如何收束。`
    : `《${title}》是${displayYearForText(movie)}的${genre || "电影"}片${director ? `，由 ${director} 执导` : ""}${actors ? `，主演 ${actors}` : ""}。这页优先给出主创、评分和相关片线索；中文剧情会在翻译配置可用后补全。`;
  return {
    title: "影片摘要",
    body,
    bullets: [
      movie.runtime ? `片长 ${movie.runtime}，观影节奏需要留出完整时间。` : "",
      movie.released ? `上映时间：${movie.released}` : "",
      movie.country ? `地区：${movie.country}` : ""
    ].filter(Boolean)
  };
}

async function buildAudienceAgent(movie) {
  const ratings = ratingsForDisplay(movie);
  const scoreLine = ratings.length
    ? ratings.map((rating) => `${rating.source} ${rating.value}`).join("，")
    : "暂无完整评分数据";
  const votes = movie.imdbVotes ? `，评分样本约 ${movie.imdbVotes}` : "";
  const awards = translateAwards(movie.cn?.awards || movie.awards);
  return {
    title: "用户口碑",
    body: `${scoreLine}${votes}${awards ? `。奖项记录：${awards}` : "。"}`,
    bullets: [
      ratings.some((rating) => rating.source === "烂番茄") ? "可同时看观众评分和媒体评分，适合判断它是大众向还是影评向。" : "",
      movie.metascore ? `Metascore ${movie.metascore}，能辅助判断专业评论的分歧程度。` : "",
      awards ? "如果你重视电影史位置，奖项和提名数量是一个可检查入口。" : ""
    ].filter(Boolean)
  };
}

async function buildCraftAgent(movie) {
  const director = compactPeople(movie.cn?.director || movie.director, 2);
  const actors = compactPeople(movie.cn?.actors || movie.actors, 3);
  const writer = compactPeople(movie.cn?.writer || movie.writer, 2);
  const genre = movie.cn?.genre || chineseGenre(movie.genre) || movie.genre;
  return {
    title: "创作线索",
    body: [director ? `导演：${director}` : "", writer ? `编剧：${writer}` : "", actors ? `主演：${actors}` : ""].filter(Boolean).join("；") || "暂无主创资料。",
    bullets: [
      genre ? `类型线索：${genre}` : "",
      movie.language ? `语言：${movie.language}` : "",
      movie.boxOffice ? `票房：${movie.boxOffice}` : ""
    ].filter(Boolean)
  };
}

function relatedReason(movie, candidate, shared) {
  const candidateTitle = clean(candidate.titleCn) || candidate.title;
  const candidatePlot = hasCjk(candidate.plot) ? sentenceSubject(candidate.plot, 82) : "";
  const sharedDirector = shared.directors[0];
  const sharedActor = shared.actors[0];
  const sharedGenre = genrePhrase(shared.genres.slice(0, 2));
  const candidateGenre = genrePhrase(candidate.genre);
  const candidateActors = compactPeople(candidate.actors, 2);
  if (sharedDirector) {
    return `同由 ${sharedDirector} 执导，可以对照他在《${candidateTitle}》里怎样处理${sharedGenre || candidateGenre || "人物关系"}和节奏。`;
  }
  if (sharedActor) {
    return `${sharedActor} 同时出现在两部片里，《${candidateTitle}》能顺着表演和人物气质继续看。`;
  }
  if (shared.genres.length && candidatePlot) {
    return `同属${shared.genres.slice(0, 2).join("、")}，《${candidateTitle}》把焦点转到“${candidatePlot}”。`;
  }
  if (shared.genres.length && candidateActors) {
    return `同属${sharedGenre}，《${candidateTitle}》换成 ${candidateActors} 的表演组合，适合比较同类型的不同气质。`;
  }
  if (candidatePlot) {
    return `《${candidateTitle}》的入口是“${candidatePlot}”，和本片一样适合看人物如何被处境推着走。`;
  }
  return `《${candidateTitle}》和本片在榜单位置、类型气质上接近，适合作为下一部延伸观看。`;
}

async function buildRelatedAgent(movie) {
  const movieGenres = splitList(movie.genre);
  const movieDirectors = splitList(movie.director);
  const movieActors = splitList(movie.actors);
  const scored = top250
    .filter((candidate) => candidate.imdbID !== movie.imdbID)
    .map((candidate) => {
      const shared = {
        genres: intersect(movieGenres, splitList(candidate.genre)),
        directors: intersect(movieDirectors, splitList(candidate.director)),
        actors: intersect(movieActors, splitList(candidate.actors))
      };
      const score = shared.directors.length * 12
        + shared.actors.length * 5
        + shared.genres.length * 3
        + (Math.abs(Number(candidate.rank) - Number(movie.rank || 999)) <= 20 ? 1 : 0);
      return { candidate, shared, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.rank - b.candidate.rank)
    .slice(0, 6);

  return scored.map(({ candidate, shared }) => ({
    imdbID: candidate.imdbID,
    rank: candidate.rank,
    title: candidate.title,
    titleCn: candidate.titleCn,
    year: candidate.year,
    poster: posterProxyPath(candidate.imdbID),
    meta: [candidate.year, genrePhrase(candidate.genre), candidate.imdbRating ? `IMDb ${candidate.imdbRating}` : ""].filter(Boolean).join(" · "),
    reason: relatedReason(movie, candidate, shared)
  }));
}

async function runDetailResearchAgents(movie) {
  if (movie.research?.version === RESEARCH_VERSION && movie.research?.generatedAt && isFresh(movie.research.generatedAt, RESEARCH_CACHE_MAX_MS)) {
    return movie.research;
  }
  const [summary, audience, craft, related] = await Promise.all([
    buildSummaryAgent(movie),
    buildAudienceAgent(movie),
    buildCraftAgent(movie),
    buildRelatedAgent(movie)
  ]);
  return {
    summary,
    audience,
    craft,
    related,
    version: RESEARCH_VERSION,
    generatedAt: new Date().toISOString()
  };
}

function researchIsFresh(movie) {
  return movie.research?.version === RESEARCH_VERSION
    && movie.research?.generatedAt
    && isFresh(movie.research.generatedAt, RESEARCH_CACHE_MAX_MS);
}

function generatedTextIsReusable(movie) {
  if (!movie.cn || !movie.why) return false;
  if (hasOldGenericFallback(movie)) return false;
  if (config.deepseekApiKey && (movie.cn.fallback || movie.why.fallback || movie.cn.error || movie.why.error)) return false;
  return true;
}

function detailIsFresh(movie, { requireResearch = false } = {}) {
  if (movie.detailVersion !== DETAIL_VERSION) return false;
  if (!isFresh(movie.detailGeneratedAt, DETAIL_CACHE_MAX_MS)) return false;
  if (!generatedTextIsReusable(movie)) return false;
  if (requireResearch && !researchIsFresh(movie)) return false;
  if (requireResearch && config.editorialApiKey && !editorialIsFresh(movie)) return false;
  return true;
}

export async function getMovie(imdbID, { generateAi = true, rank = null, chart = null, enrichResearch = false } = {}) {
  const cached = await getCachedMovie(imdbID);
  let movie = cached && isFresh(cached.omdbFetchedAt) ? cached : null;
  if (!movie) {
    movie = await fetchOmdbById(imdbID);
  }
  const chartPayload = chart || chartFromRow(findChartRow(imdbID));
  if (rank) movie.rank = rank;
  movie = mergeChart(movie, chartPayload);
  movie.poster = posterProxyPath(movie.imdbID);

  if (generateAi) {
    const freshDetail = detailIsFresh(movie, { requireResearch: enrichResearch });
    if (!freshDetail && (!generatedTextIsReusable(movie) || !hasFreshAi(movie))) {
      try {
        movie = attachChinese(movie, await generateChineseWithDeepSeek(movie));
      } catch (error) {
        movie = attachChinese(movie, fallbackChinese(movie, error.message));
      }
    } else if (!movie.cn) {
      movie = attachChinese(movie, migrateWhyOnly(movie));
    }
  } else if (!movie.cn || !movie.why || hasOldGenericFallback(movie)) {
    movie = attachChinese(movie, fallbackChinese(movie));
  }

  if (enrichResearch) {
    const [research, editorial] = await Promise.all([
      runDetailResearchAgents(movie),
      ensureEditorial(movie)
    ]);
    movie = {
      ...movie,
      research,
      ...(editorial ? { editorial } : {})
    };
  }

  if (generateAi) {
    movie.detailVersion = DETAIL_VERSION;
    movie.detailGeneratedAt = movie.detailGeneratedAt && detailIsFresh(movie, { requireResearch: enrichResearch })
      ? movie.detailGeneratedAt
      : new Date().toISOString();
  }

  return saveCachedMovie(movie);
}

export async function listTopMovies({ offset = 0, limit = 24, generateAi = false } = {}) {
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, TOP_TOTAL));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 24, 48));
  const rows = top250.slice(safeOffset, safeOffset + safeLimit);
  const movies = await mapLimit(rows, generateAi ? 2 : 8, (row) => getMovie(row.imdbID, {
    generateAi,
    rank: row.rank,
    chart: chartFromRow(row)
  }));
  return movies.sort((a, b) => Number(a.rank || 999) - Number(b.rank || 999));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function topSeed() {
  return top250;
}

export function topMovieTotal() {
  return TOP_TOTAL;
}

export function providerStatus() {
  return runtimeStatus();
}
