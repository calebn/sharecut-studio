import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewLoadingScreen } from "./ReviewLoadingScreen";

/**
 * Compares the component's static markup for a name with the fixture bytes that
 * tests/test_share_boot_header.py also reads (what the server writes into the
 * page). That the takeover in a browser moves nothing is proved by
 * e2e/guest-boot-name.spec.ts, not here.
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
