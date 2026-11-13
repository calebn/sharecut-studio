import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { isShareProjectKey } from "./shareMode";
import { useDawStore } from "./state/dawStore";
import { urlOf } from "./test/urlOf";

const seen: {
  guestMode: string | null;
  guestShare: boolean;
  share: boolean;
}[] = [];

vi.mock("./dawApp", () => ({
  DawApp: ({ guestShare = false }: { guestShare?: boolean }) => {
    const guestMode = useDawStore((s) => s.guestMode);
    const projectPath = useDawStore((s) => s.projectPath);
    seen.push({ guestMode, guestShare, share: isShareProjectKey(projectPath) });
    return (
      <div data-testid="seen">
        {JSON.stringify({ guestMode, share: isShareProjectKey(projectPath) })}
      </div>
    );
  },
}));

describe("guest bootstrap", () => {
  beforeEach(() => {
    resetFeaturesCache();
    seen.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it.each([
    ["view", ["play", "view"]],
    ["comment", ["play", "view", "comment", "reply"]],
    ["edit", ["play", "view", "comment", "reply", "edit"]],
  ])(
    "gives a %s guest mode and the guestShare flag only on a share project key",
    async (mode, capabilities) => {
      window.history.pushState({}, "", "/r/tok");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = urlOf(input);
          if (url.includes("/features")) {
            return new Response(
              JSON.stringify({
                api_version: 1,
                features: [
                  "share.ui.routes",
                  "share.ui.banner",
                  "share.ui.menu",
                ],
              }),
              { status: 200 },
            );
          }
          if (url.endsWith("/api/review/tok/project")) {
            return new Response(
              JSON.stringify({
                capabilities,
                guest_mode: mode,
                reads_transcript_words: true,
                meta: { name: "Episode" },
              }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404 });
        }),
      );
      render(<App />);
      await waitFor(() =>
        expect(
          JSON.parse(screen.getByTestId("seen").textContent ?? ""),
        ).toEqual({ guestMode: mode, share: true }),
      );
      for (const o of seen) {
        if (o.guestMode !== null || o.guestShare) expect(o.share).toBe(true);
      }
    },
  );
});
