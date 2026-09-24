/** Reject Storybook modules in the production app's resolved build graph. */

import type { Plugin } from "vite";
import { STORY_SUPPORT_MODULES } from "../src/test/storyGovernance.ts";

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
  return {
    name: "sharecut-forbid-story-modules",
    transform(_code, id) {
      if (forbiddenStoryModule(id)) {
        this.error(`Production bundle includes story module: ${id}`);
      }
    },
  };
}
