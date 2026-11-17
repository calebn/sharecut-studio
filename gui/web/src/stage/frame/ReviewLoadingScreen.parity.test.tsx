import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewLoadingScreen } from "./ReviewLoadingScreen";

/**
 * The fixture holds the bytes the server writes into the page for a name;
 * tests/test_share_boot_header.py checks the server against it and this checks
 * the component. That nothing moves when the script takes over is for
 * e2e/guest-boot-name.spec.ts.
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
