import fs from "node:fs";
import { runE2e } from "../e2e/runE2e";
const code = await runE2e(["--config=playwright.independent.config.ts"]);
// runE2e returns only after its finally block completes cleanup.
fs.writeFileSync(process.env.V3915_CLEANUP!, "PASS");
process.exitCode = code;
