import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dataPath = path.join(root, "server/data/top250-imdb.json");
const endpoint = "https://query.wikidata.org/sparql";
const batchSize = 50;

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function bestChinese(binding) {
  return binding.zhHans?.value || binding.zh?.value || binding.zhHant?.value || "";
}

async function fetchBatch(ids) {
  const values = ids.map((id) => `"${id}"`).join(" ");
  const query = `
SELECT ?imdb ?zh ?zhHans ?zhHant WHERE {
  VALUES ?imdb { ${values} }
  ?item wdt:P345 ?imdb.
  OPTIONAL { ?item rdfs:label ?zh FILTER(LANG(?zh)="zh") }
  OPTIONAL { ?item rdfs:label ?zhHans FILTER(LANG(?zhHans)="zh-hans") }
  OPTIONAL { ?item rdfs:label ?zhHant FILTER(LANG(?zhHant)="zh-hant") }
}`;
  const url = `${endpoint}?${new URLSearchParams({ query, format: "json" })}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": "QiaomuMovieGuide/1.0 https://movie.qiaomu.ai"
    }
  });
  if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
  const data = await response.json();
  return Object.fromEntries(
    (data.results?.bindings || [])
      .map((binding) => [binding.imdb?.value, bestChinese(binding)])
      .filter(([, title]) => title)
  );
}

const movies = JSON.parse(await readFile(dataPath, "utf8"));
const titleMap = {};
for (const ids of chunk(movies.map((movie) => movie.imdbID), batchSize)) {
  Object.assign(titleMap, await fetchBatch(ids));
}

let changed = 0;
for (const movie of movies) {
  const titleCn = titleMap[movie.imdbID];
  if (titleCn && titleCn !== movie.titleCn) {
    movie.titleCn = titleCn;
    changed += 1;
  }
}

await writeFile(dataPath, `${JSON.stringify(movies, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  changed,
  withChineseTitle: movies.filter((movie) => movie.titleCn).length,
  total: movies.length
}, null, 2));
