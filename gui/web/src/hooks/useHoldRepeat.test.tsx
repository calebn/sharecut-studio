import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHoldRepeat } from "./useHoldRepeat";

function HoldButton() {
  const hold = useHoldRepeat(() => false);
  return (
    <button type="button" {...hold}>
      Hold me
    </button>
  );
}

function rule(css: string, selector: string): string {
  const match = css.match(
    new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`),
  );
  return match?.[1] ?? "";
}

describe("useHoldRepeat control styling", () => {
  it("marks every hold-to-repeat button with the shared class, so no caller styles it", () => {
    render(<HoldButton />);
    expect(screen.getByRole("button", { name: "Hold me" })).toHaveClass(
      "hold-repeat",
    );
  });

  it("keeps iOS from selecting the label or opening the loupe on a held press", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(
      join(here, "../styles/partials/layout.css"),
      "utf8",
    );
    const body = rule(css, ".hold-repeat");
    expect(body).toMatch(/user-select:\s*none/);
    expect(body).toMatch(/-webkit-user-select:\s*none/);
    expect(body).toMatch(/-webkit-touch-callout:\s*none/);
  });
});
