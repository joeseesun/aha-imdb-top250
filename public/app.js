const VISITOR_KEY = "aha_movie_visitor_id";
const PAGE_SIZE = 24;

const state = {
  visitorId: getVisitorId(),
  movies: [],
  detail: null,
  query: "",
  pagination: {
    offset: 0,
    limit: PAGE_SIZE,
    total: 0,
    hasMore: false
  },
  leaderboards: { watched: [], favorites: [] },
  session: {
    authenticated: false,
    user: null,
    favorites: [],
    reactions: { watched: [], want: [] }
  },
  authMode: "login",
  route: "home",
  loading: false
};

const els = {
  accountButton: document.querySelector("#accountButton"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  statusText: document.querySelector("#statusText"),
  homeView: document.querySelector("#homeView"),
  detailView: document.querySelector("#detailView"),
  movieGrid: document.querySelector("#movieGrid"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  scrollSentinel: document.querySelector("#scrollSentinel"),
  leaderboardGrid: document.querySelector("#leaderboardGrid"),
  watchedBoard: document.querySelector("#watchedBoard"),
  favoriteBoard: document.querySelector("#favoriteBoard"),
  modalBackdrop: document.querySelector("#modalBackdrop"),
  modalTitle: document.querySelector("#modalTitle"),
  modalBody: document.querySelector("#modalBody"),
  modalClose: document.querySelector("#modalClose"),
  toast: document.querySelector("#toast")
};

function getVisitorId() {
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const next = window.crypto?.randomUUID?.() || `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(VISITOR_KEY, next);
    return next;
  } catch {
    return `v_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(title = "A") {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "A";
}

function cn(movie, key) {
  return movie?.cn?.[key] || movie?.[key] || "";
}

function displayTitle(movie) {
  const cnTitle = cn(movie, "title");
  if (hasCjk(cnTitle)) return cnTitle;
  return movie?.titleCn || movie?.chart?.titleCn || cnTitle || movie?.chart?.title || movie?.title || "Untitled";
}

function originalTitle(movie) {
  const title = displayTitle(movie);
  return movie?.title && movie.title !== title ? movie.title : "";
}

function setDocumentMeta(title, description, path = window.location.pathname) {
  document.title = title;
  const descriptionTag = document.querySelector("meta[name='description']");
  if (descriptionTag) descriptionTag.setAttribute("content", description);
  const canonical = document.querySelector("link[rel='canonical']");
  if (canonical) canonical.setAttribute("href", `${window.location.origin}${path}`);
}

function displayYear(movie) {
  return movie?.chart?.year || movie?.year || "";
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function genreLabel(value) {
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
  return map.get(value) || value;
}

function stats(movie) {
  return movie?.stats || { favorites: 0, watched: 0, want: 0 };
}

function isFavorite(imdbID) {
  return state.session.favorites?.includes(imdbID);
}

function viewerStatus(imdbID) {
  if (state.session.reactions?.watched?.includes(imdbID)) return "watched";
  if (state.session.reactions?.want?.includes(imdbID)) return "want";
  return "none";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function setStatus(message = "") {
  if (!els.statusText) return;
  const shouldAnnounce = /失败|错误|无法/.test(message);
  els.statusText.textContent = shouldAnnounce ? message : "";
  if (shouldAnnounce) showToast(message);
}

function posterMarkup(movie) {
  if (movie?.poster && movie.poster !== "N/A") {
    return `<img src="${escapeHtml(movie.poster)}" alt="${escapeHtml(displayTitle(movie))}" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(initials(displayTitle(movie)))}">`;
  }
  return `<span class="poster-fallback">${escapeHtml(initials(displayTitle(movie)))}</span>`;
}

function tagsMarkup(movie) {
  return (movie?.tags || String(cn(movie, "genre") || movie?.chart?.genre || "").split(",").map((tag) => tag.trim()).filter(Boolean))
    .slice(0, 3)
    .map((tag) => `<span class="tag">${escapeHtml(genreLabel(tag))}</span>`)
    .join("");
}

function heartIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.2 10.7 20C5.9 15.7 3 13.1 3 9.8A5 5 0 0 1 8.1 4.7c1.5 0 3 .7 3.9 1.8a5.2 5.2 0 0 1 3.9-1.8A5 5 0 0 1 21 9.8c0 3.3-2.9 5.9-7.7 10.2L12 21.2Z"/></svg>`;
}

function eyeIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c5.5 0 9 5.1 9 7s-3.5 7-9 7-9-5.1-9-7 3.5-7 9-7Zm0 2c-4.1 0-6.8 3.8-7 5 .2 1.2 2.9 5 7 5s6.8-3.8 7-5c-.2-1.2-2.9-5-7-5Zm0 2.1a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Z"/></svg>`;
}

function bookmarkIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>`;
}

function backIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.8 5.4 4.2 12l6.6 6.6 1.4-1.4L8 13h12v-2H8l4.2-4.2-1.4-1.4Z"/></svg>`;
}

function actionControls(movie, variant = "card") {
  const movieStats = stats(movie);
  const status = viewerStatus(movie.imdbID);
  const favorite = isFavorite(movie.imdbID);
  const compact = variant !== "detail";
  return `
    <div class="movie-actions ${variant === "detail" ? "movie-actions-large" : ""}">
      <button class="state-button tooltip ${compact ? "state-button-compact" : ""}" data-action="favorite" data-movie-id="${escapeHtml(movie.imdbID)}" aria-pressed="${favorite}" data-tooltip="${favorite ? "已收藏" : "收藏"}" aria-label="${favorite ? "已收藏" : "收藏"}">
        ${heartIcon()}${compact ? "" : `<span>${favorite ? "已藏" : "收藏"}</span>`}<small>${movieStats.favorites || 0}</small>
      </button>
      <button class="state-button tooltip ${compact ? "state-button-compact" : ""}" data-action="status" data-status="watched" data-movie-id="${escapeHtml(movie.imdbID)}" aria-pressed="${status === "watched"}" data-tooltip="${status === "watched" ? "已看过" : "看过"}" aria-label="${status === "watched" ? "已看过" : "看过"}">
        ${eyeIcon()}${compact ? "" : `<span>${status === "watched" ? "已看" : "看过"}</span>`}<small>${movieStats.watched || 0}</small>
      </button>
      <button class="state-button tooltip ${compact ? "state-button-compact" : ""}" data-action="status" data-status="want" data-movie-id="${escapeHtml(movie.imdbID)}" aria-pressed="${status === "want"}" data-tooltip="${status === "want" ? "已想看" : "想看"}" aria-label="${status === "want" ? "已想看" : "想看"}">
        ${bookmarkIcon()}${compact ? "" : `<span>想看</span>`}<small>${movieStats.want || 0}</small>
      </button>
    </div>
  `;
}

function cardCopy(movie) {
  if (movie?.editorial?.hook) return movie.editorial.hook;
  if (movie?.why?.headline) return movie.why.headline;
  const plot = cn(movie, "plot") || "";
  if (hasCjk(plot)) return plot;
  return [movie?.chart?.director || movie?.director, movie?.chart?.actors || movie?.actors, movie?.chart?.genre || movie?.genre]
    .filter(Boolean)
    .join(" · ") || "暂无简介。";
}

function renderMovies() {
  els.movieGrid.innerHTML = state.movies.map((movie) => {
    const title = displayTitle(movie);
    const original = originalTitle(movie);
    const rating = movie.imdbRating ? `<span class="card-rating"><b>${escapeHtml(movie.imdbRating)}</b><small>IMDb</small></span>` : "";
    return `
      <article class="movie-card" data-movie-id="${escapeHtml(movie.imdbID)}">
        <button class="movie-main" type="button" data-action="select" data-movie-id="${escapeHtml(movie.imdbID)}">
          <div class="poster-wrap">
            <span class="rank-badge">${movie.rank ? `#${movie.rank}` : "搜索"}</span>
            <div class="poster">${posterMarkup(movie)}</div>
          </div>
          <div class="movie-card-body">
            <div class="card-head">
              <h2>${escapeHtml(title)}</h2>
              ${rating}
            </div>
            ${original ? `<p class="original-title">${escapeHtml(original)}</p>` : ""}
            <div class="meta">${escapeHtml([displayYear(movie), movie.runtime || movie.chart?.runtime].filter(Boolean).join(" · "))}</div>
            <div class="mini-copy">${escapeHtml(cardCopy(movie))}</div>
            <div class="tag-row">${tagsMarkup(movie)}</div>
          </div>
        </button>
        ${actionControls(movie)}
      </article>
    `;
  }).join("");
  els.loadMoreButton.hidden = state.query || !state.pagination.hasMore;
}

function fact(label, value) {
  if (!value) return "";
  return `<div class="fact-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function publicRatingSource(source) {
  const names = new Map([
    ["Internet Movie Database", "IMDb"],
    ["Rotten Tomatoes", "烂番茄"],
    ["Metacritic", "Metacritic"]
  ]);
  return names.get(source) || source;
}

function ratingMarkup(movie) {
  const ratings = Array.isArray(movie.ratings) ? movie.ratings : [];
  return ratings.slice(0, 3).map((rating) => `
    <div class="rating-pill">
      <span>${escapeHtml(publicRatingSource(rating.Source))}</span>
      <strong>${escapeHtml(rating.Value)}</strong>
    </div>
  `).join("");
}

function researchBox(section) {
  if (!section) return "";
  const bullets = (section.bullets || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `
    <section class="research-box">
      <h3>${escapeHtml(section.title)}</h3>
      <p>${escapeHtml(section.body || "")}</p>
      ${bullets ? `<ul>${bullets}</ul>` : ""}
    </section>
  `;
}

function listMarkup(items = []) {
  const rows = items.filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return rows ? `<ul>${rows}</ul>` : "";
}

function insightBox(title, items = []) {
  const rows = listMarkup(items);
  if (!rows) return "";
  return `
    <section class="research-box">
      <h3>${escapeHtml(title)}</h3>
      ${rows}
    </section>
  `;
}

function editorialFitBox(editorial) {
  if (!editorial) return "";
  const items = [
    editorial.bestFor ? `适合：${editorial.bestFor}` : "",
    editorial.caution ? `可能不适合：${editorial.caution}` : "",
    editorial.rewatchPoint ? `二刷看点：${editorial.rewatchPoint}` : ""
  ].filter(Boolean);
  if (!items.length) return "";
  return `
    <section class="research-box">
      <h3>适合谁看</h3>
      ${listMarkup(items)}
    </section>
  `;
}

function editorialMarkup(movie) {
  const editorial = movie?.editorial;
  if (!editorial?.hook || !editorial?.intro) return "";
  const fitFor = editorial.bestFor
    ? `<div class="fit-col fit-for"><p class="fit-label">适合谁看</p><p class="fit-body">${escapeHtml(editorial.bestFor)}</p></div>`
    : "";
  const caution = editorial.caution
    ? `<div class="fit-col fit-caution"><p class="fit-label">观看提示</p><p class="fit-body">${escapeHtml(editorial.caution)}</p></div>`
    : "";
  const fitRow = (fitFor || caution) ? `<div class="fit-row">${fitFor}${caution}</div>` : "";
  const rewatch = editorial.rewatchPoint
    ? `<aside class="rewatch-card"><span class="rewatch-tag">二刷提示</span><p>${escapeHtml(editorial.rewatchPoint)}</p></aside>`
    : "";
  return `
    <section class="editorial-section" aria-label="观影入口">
      <div class="editorial-lede">
        <p class="eyebrow"><span class="eyebrow-dot"></span>观影入口</p>
        <h3>${escapeHtml(editorial.title || `${displayTitle(movie)}真正值得看的地方`)}</h3>
        <p>${escapeHtml(editorial.intro)}</p>
      </div>
      <blockquote class="editorial-hook"><span class="quote-mark" aria-hidden="true">"</span>${escapeHtml(editorial.hook)}</blockquote>
      <div class="editorial-grid">
        ${insightBox("先看这些", editorial.watchPoints || [])}
        ${insightBox("放进语境", editorial.contextNotes || [])}
        ${insightBox("创作看点", editorial.craftNotes || [])}
      </div>
      ${fitRow}
      ${rewatch}
    </section>
  `;
}

// Highlight strip directly under the hero: awards + box office + meta score.
function highlightStripMarkup(movie) {
  const awards = cn(movie, "awards") || movie?.awards;
  const boxOffice = cn(movie, "boxOffice") || movie?.boxOffice;
  const meta = movie?.metascore;
  const items = [];
  if (awards) items.push(`<div class="hl-item hl-awards"><span class="hl-label">获奖</span><span class="hl-value">${escapeHtml(awards)}</span></div>`);
  if (boxOffice) items.push(`<div class="hl-item hl-box"><span class="hl-label">票房</span><span class="hl-value">${escapeHtml(boxOffice)}</span></div>`);
  if (meta) items.push(`<div class="hl-item hl-meta"><span class="hl-label">Metacritic</span><span class="hl-value">${escapeHtml(String(meta))}<small>/100</small></span></div>`);
  if (!items.length) return "";
  return `<div class="highlight-strip">${items.join("")}</div>`;
}

function legacyWhyBox(movie, points) {
  return `
    <section class="research-box">
      <h3>观看入口</h3>
      <p>${escapeHtml(movie.why?.headline || "暂无看点。")}</p>
      ${points ? `<ul>${points}</ul>` : ""}
    </section>
  `;
}

function relatedMarkup(movie) {
  const related = movie?.research?.related || [];
  if (!related.length) return "";
  // Front-end fallback: hide a reason if it's a verbatim duplicate of an
  // earlier one (legacy/template data). Keeps each card's blurb distinct.
  const seen = new Set();
  const items = related.map((item) => {
    const reason = item.reason || "";
    const dup = reason && seen.has(reason);
    if (reason && !dup) seen.add(reason);
    return { item, reason: dup ? "" : reason };
  });
  return `
    <section class="related-section">
      <div class="section-head">
        <p class="eyebrow">延伸观看</p>
        <h2>相关电影</h2>
      </div>
      <div class="related-grid">
        ${items.map(({ item, reason }) => `
          <button class="related-card" type="button" data-action="select" data-movie-id="${escapeHtml(item.imdbID)}">
            <span class="related-poster poster">${posterMarkup(item)}</span>
            <span class="related-copy">
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.meta || [item.year, item.rank ? `#${item.rank}` : ""].filter(Boolean).join(" · "))}</small>
              ${reason ? `<span>${escapeHtml(reason)}</span>` : ""}
            </span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function plotForDetail(movie) {
  const plot = cn(movie, "plot") || movie?.plot || "";
  if (hasCjk(plot)) return plot;
  return "暂无中文剧情简介，可先看主创、口碑和相关片线索。";
}

function renderDetail() {
  const movie = state.detail;
  if (!movie) {
    els.detailView.hidden = true;
    return;
  }
  const title = displayTitle(movie);
  const original = originalTitle(movie);
  const points = (movie.why?.points || []).map((point) => `<li>${escapeHtml(point)}</li>`).join("");
  const hasEditorial = Boolean(movie.editorial?.hook && movie.editorial?.intro);
  els.detailView.hidden = false;
  els.detailView.innerHTML = `
    <button class="back-button" type="button" data-action="home">${backIcon()}<span>返回榜单</span></button>
    <section class="detail-hero">
      <div class="detail-poster poster">${posterMarkup(movie)}</div>
      <div class="detail-copy">
        <p class="eyebrow">${movie.rank ? `IMDb Top #${movie.rank}` : "电影详情"}</p>
        <h2>${escapeHtml(title)}</h2>
        ${original ? `<p class="original-title">${escapeHtml(original)}</p>` : ""}
        <div class="meta">${escapeHtml([displayYear(movie), cn(movie, "rated"), cn(movie, "runtime")].filter(Boolean).join(" · "))}</div>
        <div class="tag-row">${tagsMarkup(movie)}</div>
        <div class="rating-row">${ratingMarkup(movie)}</div>
        ${actionControls(movie, "detail")}
      </div>
    </section>
    ${highlightStripMarkup(movie)}
    ${editorialMarkup(movie)}
    <div class="detail-grid">
      ${hasEditorial ? editorialFitBox(movie.editorial) : `${researchBox(movie.research?.summary)}${legacyWhyBox(movie, points)}`}
      ${researchBox(movie.research?.audience)}
      ${hasEditorial ? "" : researchBox(movie.research?.craft)}
      <section class="research-box fact-box">
        <div class="fact-head">
          <h3>影片资料</h3>
          <a class="detail-link" href="https://www.imdb.com/title/${escapeHtml(movie.imdbID)}/" target="_blank" rel="noreferrer">IMDb ↗</a>
        </div>
        <p class="fact-plot">${escapeHtml(plotForDetail(movie))}</p>
        <div class="fact-grid">
          ${fact("导演", cn(movie, "director"))}
          ${fact("编剧", cn(movie, "writer"))}
          ${fact("主演", cn(movie, "actors"))}
          ${fact("类型", cn(movie, "genre"))}
          ${fact("上映", cn(movie, "released"))}
          ${fact("国家", cn(movie, "country"))}
          ${fact("语言", cn(movie, "language"))}
          ${fact("奖项", cn(movie, "awards"))}
          ${fact("票房", cn(movie, "boxOffice"))}
          ${fact("Metascore", movie.metascore)}
        </div>
      </section>
    </div>
    ${relatedMarkup(movie)}
  `;
}

function renderLeaderboard(target, rows, emptyText) {
  if (!rows.length) {
    target.innerHTML = `<p class="empty-row">${escapeHtml(emptyText)}</p>`;
    return;
  }
  target.innerHTML = rows.map((row, index) => {
    const movie = row.movie || {};
    return `
      <button class="leaderboard-item" type="button" data-action="select" data-movie-id="${escapeHtml(row.imdbID)}">
        <span class="board-rank">${index + 1}</span>
        <span class="board-poster poster">${posterMarkup(movie)}</span>
        <span class="board-title">
          <strong>${escapeHtml(displayTitle(movie))}</strong>
          <small>${escapeHtml([displayYear(movie), movie.imdbRating ? `IMDb ${movie.imdbRating}` : ""].filter(Boolean).join(" · "))}</small>
        </span>
        <span class="board-count">${escapeHtml(row.count)}</span>
      </button>
    `;
  }).join("");
}

function renderLeaderboards() {
  renderLeaderboard(els.watchedBoard, state.leaderboards.watched, "还没有看过记录。");
  renderLeaderboard(els.favoriteBoard, state.leaderboards.favorites, "还没有收藏记录。");
}

function mergeMovie(nextMovie) {
  const index = state.movies.findIndex((movie) => movie.imdbID === nextMovie.imdbID);
  if (index >= 0) {
    state.movies[index] = { ...state.movies[index], ...nextMovie };
  } else if (state.query) {
    state.movies.unshift(nextMovie);
  }
  if (state.detail?.imdbID === nextMovie.imdbID) {
    state.detail = { ...state.detail, ...nextMovie };
  }
}

function applyStats(imdbID, nextStats) {
  if (!nextStats) return;
  const patch = { imdbID, stats: nextStats };
  mergeMovie(patch);
  if (state.detail?.imdbID === imdbID) {
    state.detail.stats = nextStats;
  }
}

function rerenderMovieSurfaces() {
  renderMovies();
  renderDetail();
}

async function loadSession() {
  const data = await api(`/api/session?visitorId=${encodeURIComponent(state.visitorId)}`);
  state.session = {
    ...state.session,
    ...data,
    reactions: data.reactions || { watched: [], want: [] }
  };
  els.accountButton.textContent = data.authenticated ? data.user.email : "登录";
}

async function loadLeaderboards() {
  if (!els.leaderboardGrid || els.leaderboardGrid.hidden) return;
  const data = await api("/api/leaderboards?limit=6");
  state.leaderboards = {
    watched: data.watched || [],
    favorites: data.favorites || []
  };
  renderLeaderboards();
}

function showHome({ replace = false } = {}) {
  state.route = "home";
  document.body.dataset.route = "home";
  state.detail = null;
  els.homeView.hidden = false;
  els.detailView.hidden = true;
  setDocumentMeta("IMDb Top 250 | 乔木电影清单", "浏览 IMDb Top 250 高分电影，查看中文片名、影片摘要、用户口碑、相关电影推荐，并标记看过、想看和收藏。", "/");
  if (replace) window.history.replaceState({}, "", "/");
}

async function loadMovies(query = "", { append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  state.query = query;
  if (!append) {
    state.movies = [];
    state.pagination.offset = 0;
    renderMovies();
  }
  const nextOffset = append ? state.pagination.offset + state.movies.length : 0;
  const path = query
    ? `/api/movies?q=${encodeURIComponent(query)}`
    : `/api/movies?limit=${PAGE_SIZE}&offset=${nextOffset}`;
  try {
    const data = await api(path);
    const nextMovies = data.movies || [];
    state.movies = append ? [...state.movies, ...nextMovies] : nextMovies;
    state.pagination = {
      offset: data.offset || 0,
      limit: data.limit || PAGE_SIZE,
      total: data.total || state.movies.length,
      hasMore: Boolean(data.hasMore)
    };
    renderMovies();
  } finally {
    state.loading = false;
  }
}

async function loadMoreMovies() {
  if (state.query || !state.pagination.hasMore || state.loading) return;
  await loadMovies("", { append: true });
}

async function selectMovie(imdbID, { push = true } = {}) {
  state.route = "detail";
  document.body.dataset.route = "detail";
  els.homeView.hidden = true;
  els.detailView.hidden = false;
  els.detailView.innerHTML = `<div class="detail-loading">正在读取影片详情。</div>`;
  if (push) window.history.pushState({ imdbID }, "", `/movie/${imdbID}`);
  const data = await api(`/api/movies/${imdbID}`);
  state.detail = data.movie;
  mergeMovie(data.movie);
  renderDetail();
  renderMovies();
  setDocumentMeta(`${displayTitle(data.movie)} | 乔木电影清单`, `${displayTitle(data.movie)}：查看影片摘要、用户口碑、相关电影推荐，并标记看过、想看或收藏。`, `/movie/${imdbID}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function toggleFavorite(imdbID) {
  if (!state.session.authenticated) {
    openModal("auth");
    showToast("登录后可以收藏电影。");
    return;
  }
  const favorite = !isFavorite(imdbID);
  const data = await api(`/api/favorites/${imdbID}`, {
    method: "POST",
    body: JSON.stringify({ favorite })
  });
  state.session.favorites = data.favorites || [];
  applyStats(imdbID, data.stats);
  rerenderMovieSurfaces();
  await loadLeaderboards();
  showToast(favorite ? "已收藏。" : "已取消收藏。");
}

async function toggleStatus(imdbID, status) {
  const current = viewerStatus(imdbID);
  const nextStatus = current === status ? "none" : status;
  const data = await api(`/api/reactions/${imdbID}`, {
    method: "POST",
    body: JSON.stringify({ visitorId: state.visitorId, status: nextStatus })
  });
  state.session.reactions = data.reactions || { watched: [], want: [] };
  applyStats(imdbID, data.stats);
  rerenderMovieSurfaces();
  await loadLeaderboards();
  showToast(nextStatus === "watched" ? "已标记看过。" : nextStatus === "want" ? "已加入想看。" : "已取消标记。");
}

function openModal(kind) {
  let template = null;
  let title = "";
  if (kind === "reward") {
    template = document.querySelector("#rewardTemplate");
    title = "打赏支持";
  } else if (kind === "follow") {
    template = document.querySelector("#followTemplate");
    title = "关注向阳乔木推荐看";
  } else if (kind === "account") {
    template = document.querySelector("#accountTemplate");
    title = "账号";
  } else {
    template = document.querySelector("#authTemplate");
    title = "账号";
  }
  els.modalTitle.textContent = title;
  els.modalBody.replaceChildren(template.content.cloneNode(true));
  els.modalBackdrop.hidden = false;
  if (kind === "auth") setupAuthForm();
  if (kind === "account") setupAccountMenu();
  els.modalClose.focus();
}

function setupAccountMenu() {
  const email = state.session.user?.email || "未登录";
  const favCount = Array.isArray(state.session.favorites) ? state.session.favorites.length : 0;
  const emailEl = document.querySelector("#accountEmail");
  const favEl = document.querySelector("#accountFavCount");
  if (emailEl) emailEl.textContent = email;
  if (favEl) favEl.textContent = String(favCount);
  const logoutBtn = document.querySelector("#accountLogout");
  if (logoutBtn) logoutBtn.addEventListener("click", performLogout);
}

function closeModal() {
  els.modalBackdrop.hidden = true;
  els.modalBody.replaceChildren();
}

function setupAuthForm() {
  state.authMode = "login";
  const form = document.querySelector("#authForm");
  const message = document.querySelector("#authMessage");
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode || "login";
      document.querySelectorAll("[data-auth-mode]").forEach((item) => item.classList.toggle("active", item === button));
      message.textContent = "";
      form.querySelector("input[name='password']").autocomplete = state.authMode === "login" ? "current-password" : "new-password";
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const endpoint = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const data = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      state.session.authenticated = true;
      state.session.user = data.user;
      state.session.favorites = data.favorites || [];
      els.accountButton.textContent = data.user.email;
      closeModal();
      rerenderMovieSurfaces();
      showToast(state.authMode === "login" ? "登录成功。" : "注册成功。");
    } catch (error) {
      message.textContent = error.message;
    }
  });
}

async function handleAction(button) {
  const imdbID = button.dataset.movieId;
  const action = button.dataset.action;
  if (action === "home") {
    showHome();
    window.history.pushState({}, "", "/");
    if (!state.movies.length) await loadMovies();
    return;
  }
  if (action === "load-more") {
    await loadMoreMovies();
    return;
  }
  if (!imdbID) return;
  if (action === "select") {
    await selectMovie(imdbID);
  } else if (action === "favorite") {
    await toggleFavorite(imdbID);
  } else if (action === "status") {
    await toggleStatus(imdbID, button.dataset.status);
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  handleAction(button).catch((error) => showToast(error.message));
});

els.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = els.searchInput.value.trim();
  try {
    showHome();
    await loadMovies(query);
  } catch (error) {
    setStatus(`加载失败：${error.message}`);
  }
});

els.loadMoreButton.addEventListener("click", () => {
  loadMoreMovies().catch((error) => setStatus(`加载失败：${error.message}`));
});

els.accountButton.addEventListener("click", () => {
  if (!state.session.authenticated) {
    openModal("auth");
    return;
  }
  openModal("account");
});

function performLogout() {
  api("/api/auth/logout", { method: "POST", body: "{}" })
    .then(() => {
      state.session = {
        authenticated: false,
        user: null,
        favorites: [],
        reactions: state.session.reactions
      };
      els.accountButton.textContent = "登录";
      closeModal();
      rerenderMovieSurfaces();
      showToast("已退出登录。");
    })
    .catch((error) => showToast(error.message));
}

document.querySelectorAll("[data-open-modal]").forEach((button) => {
  button.addEventListener("click", () => openModal(button.dataset.openModal));
});

els.modalClose.addEventListener("click", closeModal);
els.modalBackdrop.addEventListener("click", (event) => {
  if (event.target === els.modalBackdrop) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.modalBackdrop.hidden) closeModal();
});

document.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.closest(".poster")) return;
    const fallback = document.createElement("span");
    fallback.className = "poster-fallback";
    fallback.textContent = target.dataset.fallback || "A";
    target.replaceWith(fallback);
  },
  true
);

window.addEventListener("popstate", () => {
  const match = window.location.pathname.match(/^\/movie\/(tt\d+)/);
  if (match) {
    selectMovie(match[1], { push: false }).catch((error) => setStatus(`加载失败：${error.message}`));
  } else {
    showHome();
  }
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      loadMoreMovies().catch((error) => setStatus(`加载失败：${error.message}`));
    }
  }, { rootMargin: "600px 0px" });
  observer.observe(els.scrollSentinel);
}

Promise.all([loadSession(), loadLeaderboards()])
  .then(async () => {
    const match = window.location.pathname.match(/^\/movie\/(tt\d+)/);
    if (match) {
      await selectMovie(match[1], { push: false });
    } else {
      showHome({ replace: true });
      await loadMovies();
    }
  })
  .catch((error) => {
    setStatus(`加载失败：${error.message}`);
  });
