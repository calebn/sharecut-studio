import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewLoadingScreen } from "./ReviewLoadingScreen";

/**
 * The page the server answers carries this loading header before the script
 * runs (`inject_share_boot_header`); tests/test_share_boot_header.py reads the
 * same file. React's first commit then draws the same bytes, so nothing moves.
 */
const CASES = (
  JSON.parse(
    readFileSync(
      join(__dirname, "__fixtures__/review-boot-header.json"),
      "utf8",
    ),
  ) as { cases: { label: string; name: string; markup: string }[] }
).cases;

describe("the loading header the server writes into the page", () => {
  it.each(CASES)(
    "is what ReviewLoadingScreen renders for the name: $label",
    ({ name, markup }) => {
      expect(
        renderToStaticMarkup(
          <ReviewLoadingScreen name={name} onRetry={() => {}} />,
        ),
      ).toBe(markup);
    },
  );
});
