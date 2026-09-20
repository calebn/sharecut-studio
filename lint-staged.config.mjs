import path from "node:path";

const webRoot = path.resolve("gui/web");

export default {
  "*.py": "ruff format --",
  "gui/web/**/*.{ts,tsx,js,jsx,cjs,mjs,cts,mts,json,jsonc,css}": (files) => {
    const rels = files.map((file) => path.relative(webRoot, file));
    return `cd gui/web && biome check --write --files-ignore-unknown=true --no-errors-on-unmatched -- ${rels.map((rel) => JSON.stringify(rel)).join(" ")}`;
  },
};
