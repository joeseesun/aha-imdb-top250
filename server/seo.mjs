import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, rootDir } from "./config.mjs";
import { posterProxyPath, topSeed } from "./movies.mjs";

const indexPath = path.join(rootDir, "public/index.html");
const siteName = "乔木电影清单";
const homeTitle = "IMDb Top 250 | 乔木电影清单";
const homeDescription = "浏览 IMDb Top 250 高分电影，查看中文片名、影片摘要、用户口碑、相关电影推荐，并标记看过、想看和收藏。";

function publicUrl(pathname = "/") {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value).replaceAll("\n", " ");
}

function escapeJsonScript(value) {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

function splitList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
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
  return splitList(value).map((item) => map.get(item) || item).join("、");
}

function movieTitle(movie) {
  return movie?.titleCn ? `${movie.titleCn} ${movie.title}` : movie?.title || "电影详情";
}

function movieDescription(movie) {
  const genre = chineseGenre(movie.genre) || movie.genre || "电影";
  const director = splitList(movie.director).slice(0, 2).join("、");
  const actors = splitList(movie.actors).slice(0, 3).join("、");
  const score = movie.imdbRating ? `IMDb ${movie.imdbRating}` : "";
  return [
    movie.titleCn ? `《${movie.titleCn}》` : `《${movie.title}》`,
    movie.year ? `${movie.year} 年` : "",
    genre,
    director ? `导演 ${director}` : "",
    actors ? `主演 ${actors}` : "",
    score,
    movie.plot ? `剧情入口：${movie.plot}` : ""
  ].filter(Boolean).join("，").slice(0, 210);
}

function metaTags({ title, description, canonical, image, type = "website", jsonLd }) {
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeAttr(description)}">`,
    `<meta name="robots" content="index,follow,max-image-preview:large">`,
    `<link rel="canonical" href="${escapeAttr(canonical)}">`,
    `<meta property="og:site_name" content="${escapeAttr(siteName)}">`,
    `<meta property="og:type" content="${escapeAttr(type)}">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(canonical)}">`,
    image ? `<meta property="og:image" content="${escapeAttr(image)}">` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
    image ? `<meta name="twitter:image" content="${escapeAttr(image)}">` : "",
    `<script type="application/ld+json">${escapeJsonScript(jsonLd)}</script>`
  ].filter(Boolean).join("\n    ");
}

function homeJsonLd() {
  const movies = topSeed();
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: siteName,
      url: publicUrl("/"),
      potentialAction: {
        "@type": "SearchAction",
        target: `${publicUrl("/")}?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "IMDb Top 250",
      numberOfItems: movies.length,
      itemListElement: movies.slice(0, 50).map((movie) => ({
        "@type": "ListItem",
        position: movie.rank,
        url: publicUrl(`/movie/${movie.imdbID}`),
        name: movie.titleCn || movie.title
      }))
    }
  ];
}

function movieJsonLd(movie, canonical, image) {
  return {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: movie.titleCn || movie.title,
    alternateName: movie.titleCn ? movie.title : undefined,
    url: canonical,
    image,
    datePublished: movie.year ? String(movie.year) : undefined,
    description: movieDescription(movie),
    genre: splitList(movie.genre),
    director: splitList(movie.director).map((name) => ({ "@type": "Person", name })),
    actor: splitList(movie.actors).map((name) => ({ "@type": "Person", name })),
    aggregateRating: movie.imdbRating ? {
      "@type": "AggregateRating",
      ratingValue: movie.imdbRating,
      bestRating: 10,
      ratingCount: movie.imdbVotes ? Number(String(movie.imdbVotes).replaceAll(",", "")) || undefined : undefined
    } : undefined
  };
}

function injectSeo(template, tags) {
  return template
    .replace(/<title>.*?<\/title>/, "")
    .replace(/<meta name="description" content=".*?">/, "")
    .replace("<!-- SEO_HEAD -->", tags);
}

export async function renderAppHtml(pathname = "/") {
  const template = await readFile(indexPath, "utf8");
  const movieMatch = pathname.match(/^\/movie\/(tt\d+)/);
  if (movieMatch) {
    const movie = topSeed().find((item) => item.imdbID === movieMatch[1]);
    if (movie) {
      const canonical = publicUrl(`/movie/${movie.imdbID}`);
      const image = publicUrl(posterProxyPath(movie.imdbID));
      return injectSeo(template, metaTags({
        title: `${movieTitle(movie)} | ${siteName}`,
        description: movieDescription(movie),
        canonical,
        image,
        type: "video.movie",
        jsonLd: movieJsonLd(movie, canonical, image)
      }));
    }
  }
  return injectSeo(template, metaTags({
    title: homeTitle,
    description: homeDescription,
    canonical: publicUrl("/"),
    image: publicUrl("/icons/aha-logo.svg"),
    jsonLd: homeJsonLd()
  }));
}

export function sitemapXml() {
  const urls = [
    { loc: publicUrl("/"), priority: "1.0" },
    ...topSeed().map((movie) => ({
      loc: publicUrl(`/movie/${movie.imdbID}`),
      priority: movie.rank <= 50 ? "0.9" : "0.8"
    }))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${escapeHtml(url.loc)}</loc><changefreq>monthly</changefreq><priority>${url.priority}</priority></url>`).join("\n")}\n</urlset>\n`;
}

export function robotsTxt() {
  return `User-agent: *\nAllow: /\nSitemap: ${publicUrl("/sitemap.xml")}\n`;
}
