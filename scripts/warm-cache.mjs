import { fetchPoster, getMovie, listTopMovies } from "../server/movies.mjs";

const limit = Number(process.env.WARM_LIMIT || 250);
const pageSize = 48;
const generateAi = process.env.WARM_AI !== "0";
const warmDetails = process.env.WARM_DETAILS !== "0";
const warmPosters = process.env.WARM_POSTERS !== "0";
const warmEditorial = process.env.WARM_EDITORIAL !== "0";
const detailConcurrency = Math.max(1, Math.min(Number(process.env.WARM_DETAIL_CONCURRENCY || 2), 8));
const warmRetries = Math.max(1, Math.min(Number(process.env.WARM_RETRIES || 3), 6));
const editorialAttempts = Math.max(1, Math.min(Number(process.env.WARM_EDITORIAL_ATTEMPTS || 2), 4));

const movies = [];
for (let offset = 0; movies.length < limit; offset += pageSize) {
  const batch = await listTopMovies({ offset, limit: Math.min(pageSize, limit - movies.length), generateAi });
  if (!batch.length) break;
  movies.push(...batch);
}

let detailCount = 0;
let editorialCount = 0;
let posterCount = 0;
let posterErrors = 0;
if (warmDetails || warmPosters) {
  await mapLimit(movies, detailConcurrency, async (movie, index) => {
    if (warmDetails) {
      let detailed = movie;
      for (let attempt = 0; attempt < warmRetries; attempt += 1) {
        detailed = await getMovie(movie.imdbID, {
          generateAi,
          enrichResearch: true,
          generateEditorial: warmEditorial,
          editorialAttempts
        });
        if (!warmEditorial || detailed.editorial?.hook) break;
      }
      movies[index] = detailed;
      if (detailed.editorial?.hook) editorialCount += 1;
      detailCount += 1;
    }
    if (warmPosters) {
      try {
        await fetchPoster(movie.imdbID);
        posterCount += 1;
      } catch {
        posterErrors += 1;
      }
    }
  });
}

const missingEditorial = movies
  .filter((movie) => warmDetails && warmEditorial && !movie.editorial?.hook)
  .map((movie) => ({
    rank: movie.rank,
    imdbID: movie.imdbID,
    title: movie.titleCn || movie.title
  }));

console.log(JSON.stringify({
  ok: true,
  count: movies.length,
  details: detailCount,
  editorial: editorialCount,
  missingEditorial,
  posters: posterCount,
  posterErrors,
  generated: movies.filter((movie) => movie.why && !movie.why.fallback).length,
  fallback: movies.filter((movie) => movie.why?.fallback).length
}, null, 2));

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
