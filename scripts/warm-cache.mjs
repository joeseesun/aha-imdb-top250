import { listTopMovies } from "../server/movies.mjs";

const limit = Number(process.env.WARM_LIMIT || 250);
const pageSize = 48;
const generateAi = process.env.WARM_AI !== "0";

const movies = [];
for (let offset = 0; movies.length < limit; offset += pageSize) {
  const batch = await listTopMovies({ offset, limit: Math.min(pageSize, limit - movies.length), generateAi });
  if (!batch.length) break;
  movies.push(...batch);
}

console.log(JSON.stringify({
  ok: true,
  count: movies.length,
  generated: movies.filter((movie) => movie.why && !movie.why.fallback).length,
  fallback: movies.filter((movie) => movie.why?.fallback).length
}, null, 2));
