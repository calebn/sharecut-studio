import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { HOME_SCREEN_HINT_DISMISSED_KEY } from "../utils/homeScreenHint";
import { HomeScreenHint } from "./HomeScreenHint";

const HINT =
  "In Safari's Share menu, choose Add to Home Screen to open Sharecut full screen.";

function browse(standalone: boolean) {
  for (const [key, value] of Object.entries({ standalone, maxTouchPoints: 5 }))
    Object.defineProperty(navigator, key, { value, configurable: true });
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        media: query,
        matches: query === "(display-mode: browser)" && !standalone,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

describe("HomeScreenHint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ["standalone", "maxTouchPoints"])
      Reflect.deleteProperty(navigator, key);
    localStorage.removeItem(HOME_SCREEN_HINT_DISMISSED_KEY);
  });

  it("shows in an iOS Safari tab until dismissed, then stays away", async () => {
    browse(false);
    const { container, unmount } = render(<HomeScreenHint />);
    const banner = screen.getByRole("complementary", { name: "Full screen" });
    expect(banner).toHaveTextContent(HINT);
    await expectNoA11yViolations(container);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(HINT)).toBeNull();
    unmount();

    render(<HomeScreenHint />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("stays away once Sharecut runs from the Home Screen", () => {
    browse(true);
    render(<HomeScreenHint />);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
