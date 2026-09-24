#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { bundleStoryLeaks } from "./check-bundle-no-stories";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const leaks = bundleStoryLeaks(dist);
if (leaks.length) {
  process.stderr.write(
    `Production bundle includes story modules:\n${leaks.join("\n")}\n`,
  );
  process.exitCode = 1;
}
