import path from "node:path";

const webRoot = path.resolve("gui/web");

export default {
  "*.py": "ruff format --",
  "gui/web/**/*.{ts,tsx,js,jsx,cjs,mjs,cts,mts,json,jsonc,css}": (files) => {
    const rels = files.map((file) => path.relative(webRoot, file));
    // lint-staged (>=16) runs task commands without a shell, so `cd gui/web && …`
    // can't be inlined here; scripts/lint-staged-biome.sh does the `cd` itself.
    return `scripts/lint-staged-biome.sh ${rels.map((rel) => JSON.stringify(rel)).join(" ")}`;
  },
};
