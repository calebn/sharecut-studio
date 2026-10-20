import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openCreateMenu,
  registerCreateMenuOpener,
} from "../commands/createMenuHost";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { place } from "../test/hitDom";
import { HIT_SURFACE_PROPS } from "./hitTargets";
import { keyboardCreateAnchor } from "./touchGrammar";

let root: HTMLDivElement;

function laneFor(id: string, top: number): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-track-id", id);
  place(el, { left: 0, top, right: 800, bottom: top + 100 });
  root.append(el);
  return el;
}

beforeEach(() => {
  root = document.createElement("div");
  place(root, { left: 50, top: 0, right: 850, bottom: 400 });
  document.body.append(root);
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [
        sampleTrack({ id: "music", role: "music" }),
        sampleTrack({ id: "host" }),
        sampleTrack({ id: "guest" }),
      ],
    }),
  );
  useDawStore.setState({ playheadSec: 2, zoomPxPerSec: 100 });
});

afterEach(() => {
  root.remove();
});

describe("keyboardCreateAnchor", () => {
  it("anchors at the playhead on the first selected track", () => {
    laneFor("host", 0);
    const guest = laneFor("guest", 100);
    useDawStore.getState().selectTracks(["guest"]);

    expect(keyboardCreateAnchor(root)).toEqual({
      origin: { x: 250, y: 150 },
      surface: guest,
    });
  });

  it("falls back to the first dialogue track, skipping music", () => {
    laneFor("music", 0);
    const host = laneFor("host", 100);
    useDawStore.getState().setSelection(null);

    expect(keyboardCreateAnchor(root)?.surface).toBe(host);
  });

  it("anchors over a focused hit target instead", () => {
    laneFor("host", 0);
    const slider = document.createElement("div");
    for (const [k, v] of Object.entries(HIT_SURFACE_PROPS)) {
      slider.setAttribute(k, v);
    }
    slider.tabIndex = 0;
    place(slider, { left: 100, top: 20, right: 140, bottom: 40 });
    root.append(slider);
    slider.focus();

    expect(keyboardCreateAnchor(root)).toEqual({
      origin: { x: 120, y: 30 },
      surface: slider,
    });
  });

  it("is null with no lane to put the menu on", () => {
    expect(keyboardCreateAnchor(root)).toBeNull();
  });
});

describe("create.menu", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
  });

  it("asks the mounted timeline, and says so when none is mounted", async () => {
    expect(await execute("create.menu", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "No track to create on",
    });
    const open = vi.fn(() => true);
    const unregister = registerCreateMenuOpener(open);
    expect(await execute("create.menu", {}, { skipWhen: true })).toEqual({
      status: "ok",
    });
    expect(open).toHaveBeenCalledOnce();
    unregister();
    expect(openCreateMenu()).toBe(false);
  });
});
