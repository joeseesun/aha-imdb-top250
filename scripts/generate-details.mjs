process.env.WARM_LIMIT ||= "250";
process.env.WARM_DETAILS ||= "1";
process.env.WARM_POSTERS ||= "0";
process.env.WARM_EDITORIAL ||= "1";

await import("./warm-cache.mjs");
