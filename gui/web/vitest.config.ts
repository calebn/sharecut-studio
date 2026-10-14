import { configDefaults, defineConfig } from "vitest/config";

const nodeTestFiles = [
  "src/edit/clipEdgePreview.test.ts",
  "src/edit/clipboard.test.ts",
  "src/edit/dragThreshold.test.ts",
  "src/edit/fadeLimits.test.ts",
  "src/edit/ghostPreview.test.ts",
  "src/edit/joinRender.test.ts",
  "src/edit/nudgeBoundaries.test.ts",
  "src/edit/rangeSelection.test.ts",
  "src/edit/ripplePreview.test.ts",
  "src/edit/rollLimits.test.ts",
  "src/edit/trimLimits.test.ts",
  "src/utils/time.test.ts",
  "src/utils/timebase.test.ts",
  "src/utils/zoom.test.ts",
  "src/utils/snap.test.ts",
  "src/utils/timelinePointer.test.ts",
  "src/utils/timelineViewport.test.ts",
  "src/audio/proxyMath.test.ts",
  "src/audio/wavHeader.encode.test.ts",
];

export default defineConfig({
  test: {
    // Avoid process-per-file startup under endpoint scanning while preserving
    // per-file isolation and bounded parallelism.
    pool: "threads",
    maxWorkers: 4,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: nodeTestFiles,
          setupFiles: [],
        },
      },
      {
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}", "e2e/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...nodeTestFiles],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
