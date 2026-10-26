import { composeStory } from "@storybook/react-vite";
import { afterEach, describe, expect, it } from "vitest";
import { listRegisteredIds } from "../commands/execute";
import { useHasFeature } from "../extensions/FeaturesContext";
import {
  FEATURE_SHARE_UI_BANNER,
  FEATURE_TUNNEL_STATUS,
} from "../extensions/features";
import { askConfirm, useAskStore } from "../feedback/ask";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { recordRoom, selections } from "./episodeFixture";
import { episodeActive, hydrateEpisode } from "./hydrateEpisode";
import { episodeBeforeEach, withEpisode } from "./withEpisode";

const cleanups: Array<() => Promise<void>> = [];

function hydrate(config?: Parameters<typeof hydrateEpisode>[0]) {
  const cleanup = hydrateEpisode(config);
  cleanups.push(cleanup);
  return cleanup;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("hydrateEpisode", () => {
  it("opens a host by path and a guest by share key with the role's capabilities", async () => {
    hydrate();
    expect(useDawStore.getState().projectPath).toBe(
      "/episodes/after-hours/episode.project.json",
    );
    expect(useDawStore.getState().guestMode).toBeNull();
    expect(useDawStore.getState().project?.tracks).toHaveLength(2);
    await cleanups.pop()?.();

    hydrate({ role: "commenter", selection: selections.comment });
    const state = useDawStore.getState();
    expect(state.projectPath).toBe("share:episode");
    expect(state.guestMode).toBe("comment");
    expect(state.shareCapabilities).toContain("comment");
    expect(state.selection).toEqual(selections.comment);
  });

  it("answers configured paths with JSON and everything else with a 503", async () => {
    hydrate({
      responses: {
        "/api/history": ["list"],
        "/api/history/diff": ["diff"],
        "POST /api/steps": ["posted"],
      },
      hang: ["/api/slow"],
    });
    expect(await (await fetch("/api/history?x=1")).json()).toEqual(["list"]);
    expect(await (await fetch("/api/history/diff")).json()).toEqual(["diff"]);
    expect((await fetch("/api/history/other")).status).toBe(503);
    expect((await fetch("/api/steps")).status).toBe(503);
    const posted = await fetch("/api/steps", { method: "POST" });
    expect(await posted.json()).toEqual(["posted"]);
    const outcome = await Promise.race([
      fetch("/api/slow").then(() => "answered"),
      Promise.resolve("pending"),
    ]);
    expect(outcome).toBe("pending");
  });

  it("aborts a request that hangs when the episode unmounts", async () => {
    const cleanup = hydrate({ hang: ["/api/slow"] });
    const aborted = expect(fetch("/api/slow")).rejects.toMatchObject({
      name: "AbortError",
    });
    cleanups.pop();
    await cleanup();
    await aborted;
  });

  it("restores the store, the commands and the network stubs, twice", async () => {
    const before = useDawStore.getState();
    const { fetch, WebSocket } = globalThis;
    for (let round = 0; round < 2; round += 1) {
      const cleanup = hydrate({ role: "editor" });
      expect(useDawStore.getState()).not.toBe(before);
      expect(listRegisteredIds()).toContain("tighten.applyHit");
      expect(globalThis.fetch).not.toBe(fetch);
      expect(episodeActive()).toBe(true);
      cleanups.pop();
      await cleanup();
      expect(useDawStore.getState()).toBe(before);
      expect(listRegisteredIds()).toEqual([]);
      expect(globalThis.fetch).toBe(fetch);
      expect(globalThis.WebSocket).toBe(WebSocket);
      expect(episodeActive()).toBe(false);
    }
  });

  it("keeps a newer episode when the older one cleans up late", async () => {
    const { fetch } = globalThis;
    const first = hydrate({ responses: { "/api/a": "first" } });
    const second = hydrate({
      role: "viewer",
      responses: { "/api/a": "second" },
    });
    cleanups.splice(0);
    await first();
    expect(episodeActive()).toBe(true);
    expect(useDawStore.getState().guestMode).toBe("view");
    expect(await (await globalThis.fetch("/api/a")).json()).toBe("second");
    await second();
    expect(episodeActive()).toBe(false);
    expect(globalThis.fetch).toBe(fetch);
    expect(useDawStore.getState().guestMode).toBeNull();
  });

  it("drops an open question and the preferences a story wrote", async () => {
    localStorage.setItem("kept", "yes");
    const cleanup = hydrate();
    localStorage.setItem("kept", "no");
    localStorage.setItem("leaked", "1");
    const answer = askConfirm({
      title: "Remove?",
      message: "Gone.",
      keepLabel: "Keep",
      actionLabel: "Remove",
      danger: true,
    });
    expect(useAskStore.getState().pending).not.toBeNull();
    cleanups.pop();
    await cleanup();
    expect(await answer).toBe(false);
    expect(useAskStore.getState().pending).toBeNull();
    expect(localStorage.getItem("kept")).toBe("yes");
    expect(localStorage.getItem("leaked")).toBeNull();
    localStorage.removeItem("kept");
  });

  it("shows the host's record room and clears it on cleanup", async () => {
    const cleanup = hydrate({ record: recordRoom });
    expect(useRecordHostStore.getState().snapshot?.state).toBe("recording");
    expect(useRecordHostStore.getState().connected).toBe(true);
    cleanups.pop();
    await cleanup();
    expect(useRecordHostStore.getState().snapshot).toBeNull();
    expect(useRecordHostStore.getState().connected).toBe(false);
  });
});

function FeaturesProbe() {
  const banner = useHasFeature(FEATURE_SHARE_UI_BANNER);
  const tunnel = useHasFeature(FEATURE_TUNNEL_STATUS);
  return (
    <p>
      banner {String(banner)}, tunnel {String(tunnel)}
    </p>
  );
}

describe("withEpisode", () => {
  const meta = {
    component: FeaturesProbe,
    decorators: [withEpisode],
    beforeEach: episodeBeforeEach,
  };

  it.each([
    ["host", undefined, "banner true, tunnel true"],
    ["commenter", undefined, "banner true, tunnel false"],
    ["viewer", [], "banner false, tunnel false"],
  ] as const)(
    "offers the %s the features the server would",
    async (role, features, text) => {
      const Story = composeStory(
        { parameters: { episode: { role, features } } },
        meta,
      );
      const canvasElement = document.body.appendChild(
        document.createElement("div"),
      );
      await Story.run({ canvasElement });
      expect(canvasElement).toHaveTextContent(text);
      canvasElement.remove();
    },
  );
});
