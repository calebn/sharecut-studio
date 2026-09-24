/** Reject Storybook modules in the production app's resolved build graph. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { STORY_SUPPORT_MODULES } from "../src/test/storyGovernance.ts";

function publicScripts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return publicScripts(path);
    return entry.isFile() && /\.[cm]?js$/i.test(entry.name) ? [path] : [];
  });
}

export function forbiddenStoryModule(id: string): boolean {
  const path = id.split("?", 1)[0].replaceAll("\\", "/");
  const srcRelative = path.match(/(?:^|\/)src\/(.+)$/)?.[1];
  return (
    /\.stories\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|\/)node_modules\/(?:@storybook|storybook)\//.test(path) ||
    (srcRelative !== undefined && STORY_SUPPORT_MODULES.has(srcRelative))
  );
}

export function forbidStoryModules(): Plugin {
  let publicDir: string;
  return {
    name: "sharecut-forbid-story-modules",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    buildStart() {
      for (const path of publicScripts(publicDir)) {
        this.error(
          `Uninspected public JavaScript can ship story code: ${path}`,
        );
      }
    },
    transform(_code, id) {
      if (forbiddenStoryModule(id)) {
        this.error(`Production bundle includes story module: ${id}`);
      }
    },
  };
}
