import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The system stylesheet's text, resolved from this file's directory so it does not depend on the cwd. */
export const systemCss = (): string =>
  readFileSync(
    join(import.meta.dirname, "../styles/partials/system.css"),
    "utf8",
  );
