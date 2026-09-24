/** Reject Storybook modules or story paths in the shipped JavaScript. */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function storyMarkers(source: string): string[] {
  const markers: string[] = [];
  if (/\.stories(?:\.[cm]?[jt]sx?)?(?![\w])/i.test(source)) {
    markers.push("story file");
  }
  if (/@storybook\//i.test(source)) {
    markers.push("@storybook package");
  }
  if (/(?:^|[^\w@])storybook\//i.test(source)) {
    markers.push("storybook package");
  }
  return markers;
}

export function bundleStoryLeaks(distDir: string): string[] {
  const leaks: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && path.endsWith(".js")) {
        for (const marker of storyMarkers(readFileSync(path, "utf8"))) {
          leaks.push(`${relative(distDir, path)}: ${marker}`);
        }
      }
    }
  };
  visit(distDir);
  return leaks;
}
