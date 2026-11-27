import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { COMMENTER_CAPABILITIES, clipRow } from "../../test/fixtures";
import { StoredGuestScriptHost } from "../../test/StoredGuestScriptHost";
import { seedScript } from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";

const anchorWithin = vi.hoisted(() => vi.fn());

vi.mock("../../commands/seek", () => ({ seekTransport: vi.fn() }));
vi.mock("../edit/useSelectionAnchor", async (orig) => {
  const real = await orig<typeof import("../edit/useSelectionAnchor")>();
  return {
    ...real,
    useSelectionAnchor: (
      ...args: Parameters<typeof real.useSelectionAnchor>
    ) => {
      anchorWithin(args[0], args[3]);
      return real.useSelectionAnchor(...args);
    },
  };
});

const CLIPS = {
  tracks: {
    host: [
      clipRow({
        id: "ch",
        track_id: "host",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
  },
  clip_count: 1,
};

function mount(shell: "tablet" | "desktop", handheld: boolean) {
  stubViewportShell(shell, { handheld });
  seedScript({
    projectPath: "share:abc",
    guestMode: "comment",
    shareCapabilities: COMMENTER_CAPABILITIES,
    project: { clips: CLIPS },
  });
  useDawStore.setState({ shellBreakpoint: shell, handheldLandscape: handheld });
  render(<StoredGuestScriptHost />);
  act(() =>
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: "host",
      sourceId: null,
      startWordIndex: 0,
      endWordIndex: 1,
    }),
  );
}

beforeEach(() => anchorWithin.mockReset());
afterEach(() => {
  act(() => useDawStore.getState().setSelection(null));
  useDawStore.setState({ handheldLandscape: false });
  vi.unstubAllGlobals();
});

describe("the guest selection bar's room", () => {
  it("may use the whole page on a handheld in landscape, as on a phone", () => {
    mount("tablet", true);
    const [root, within] = anchorWithin.mock.calls.at(-1) ?? [];
    expect(root).toBeInstanceOf(HTMLElement);
    expect(within).toBe(document.documentElement);
  });

  it("stays inside the transcript on a tablet that is not a handheld", () => {
    mount("tablet", false);
    const [root, within] = anchorWithin.mock.calls.at(-1) ?? [];
    expect(root).toBeInstanceOf(HTMLElement);
    expect(within).toBe(root);
  });
});
