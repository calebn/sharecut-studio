import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { useHeaderProps } from "./stage/frame/useHeaderProps";
import { useReadsSavedCopy } from "./state/savedCopy";
import { AppHeader } from "./system/AppHeader";
import { minimalProject } from "./test/fixtures";
import { urlOf } from "./test/urlOf";

/** A studio stand-in that says what page it is, and wears the real header. */
function FakeStudio() {
  const savedCopy = useReadsSavedCopy();
  return (
    <div>
      <p>{savedCopy ? "Reading the saved copy" : "Reading the live episode"}</p>
      <AppHeader {...useHeaderProps()} />
    </div>
  );
}
vi.mock("./dawApp", () => ({ DawApp: FakeStudio }));

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

const EDIT_CAPABILITIES = ["play", "view", "comment", "reply", "edit"];

/** An Editor link whose first read of the project fails; later reads succeed. */
function stubLinkFirstReadFails() {
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/features")) return new Response(FEATURES);
      if (url.endsWith("/project")) {
        if (!failed) {
          failed = true;
          throw new TypeError("Failed to fetch");
        }
        return new Response(
          JSON.stringify({
            capabilities: EDIT_CAPABILITIES,
            guest_mode: "edit",
            reads_transcript_words: false,
            meta: { name: "Episode" },
          }),
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

beforeEach(() => {
  resetFeaturesCache();
  localStorage.clear();
  offline.load.mockReset().mockResolvedValue({ project: minimalProject() });
  offline.clear.mockReset().mockResolvedValue(undefined);
  window.history.pushState({}, "", "/r/saved-copy-tok");
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  resetFeaturesCache();
});

describe("the header on a saved copy the guest opened because the link was not reached", () => {
  it("shows no role chip, so an Editor link is not called Viewer", async () => {
    stubLinkFirstReadFails();
    render(<App />);
    expect(await screen.findByText("Reading the saved copy")).toBeVisible();
    expect(screen.queryByRole("button", { name: /role/ })).toBeNull();
    for (const role of ["Editor", "Commenter", "Viewer"]) {
      expect(screen.queryByText(role)).toBeNull();
      expect(screen.queryByLabelText(new RegExp(role))).toBeNull();
    }
  });
});
