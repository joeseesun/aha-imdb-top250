import { fetchPoster, getMovie, listTopMovies } from "../server/movies.mjs";

const limit = Number(process.env.WARM_LIMIT || 250);
const pageSize = 48;
const generateAi = process.env.WARM_AI !== "0";
const warmDetails = process.env.WARM_DETAILS !== "0";
const warmPosters = process.env.WARM_POSTERS !== "0";

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
  for (const [index, movie] of movies.entries()) {
    if (warmDetails) {
      const detailed = await getMovie(movie.imdbID, { generateAi, enrichResearch: true });
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
  }
}

console.log(JSON.stringify({
  ok: true,
  count: movies.length,
  details: detailCount,
  editorial: editorialCount,
  posters: posterCount,
  posterErrors,
  generated: movies.filter((movie) => movie.why && !movie.why.fallback).length,
  fallback: movies.filter((movie) => movie.why?.fallback).length
}, null, 2));
