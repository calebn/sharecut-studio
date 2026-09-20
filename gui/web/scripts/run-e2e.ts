import { runE2e } from "../e2e/runE2e";

process.exitCode = await runE2e(process.argv.slice(2));
