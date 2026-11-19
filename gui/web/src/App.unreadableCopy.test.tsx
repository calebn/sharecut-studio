import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

vi.mock("./dawApp", () => ({ DawApp: () => <div>Guest studio</div> }));

const offline = vi.hoisted(() => ({ load: vi.fn(), clear: vi.fn() }));
vi.mock("./services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./services/offlineQueue/offlineStore")
  >()),
  loadOfflineSnapshot: offline.load,
  clearOfflineSnapshot: offline.clear,
}));

const FEATURES = JSON.stringify({
  api_version: 1,
  features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
});

beforeEach(() => {
  offline.load.mockReset();
  offline.clear.mockReset().mockResolvedValue(undefined);
  resetFeaturesCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  resetFeaturesCache();
});

describe("a saved copy that cannot be read after the first load failed", () => {
  it.each([
    [
      "the host's computer is asleep",
      () => {
        throw new TypeError("Failed to fetch");
      },
      "The host's computer is asleep",
    ],
    [
      "a server error",
      () => new Response("boom", { status: 500 }),
      "This link did not load",
    ],
  ])(
    "ends on the cover for the original failure (%s), never on Home",
    async (_name, fail, title) => {
      offline.load.mockRejectedValue(
        new DOMException("denied", "SecurityError"),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          urlOf(input).includes("/features") ? new Response(FEATURES) : fail(),
        ),
      );
      window.history.pushState({}, "", "/r/unreadable-copy");
      render(<App />);
      expect(
        await screen.findByRole("heading", { name: title }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Import audio")).toBeNull();
    },
  );
});
