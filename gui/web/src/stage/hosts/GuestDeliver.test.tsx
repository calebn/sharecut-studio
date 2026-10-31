import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listExportedFiles: listed.list,
}));
vi.mock("../../stages/deliver/FeedPanel", () => ({ FeedPanel: () => null }));

import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { GuestDeliver } from "./GuestDeliver";

const FILES = [
  {
    id: "ep.mp3",
    name: "ep.mp3",
    kind: "audio",
    label: "Listening file",
    bytes: 5_000_000,
    current: true,
  },
  {
    id: "ep.srt",
    name: "ep.srt",
    kind: "transcript",
    label: "Captions",
    bytes: 900,
    current: true,
  },
  {
    id: "ep.chapters.json",
    name: "ep.chapters.json",
    kind: "chapters",
    label: "Chapters",
    bytes: 300,
    current: true,
  },
];

function asGuest(guestMode: "edit" | "comment" | "view") {
  useDawStore
    .getState()
    .hydrate(
      shareProjectKey("tok123"),
      minimalProject({ tracks: [sampleTrack()] }),
    );
  useDawStore.setState({ stage: "deliver", guestMode });
}

beforeEach(() => {
  stubViewportShell("desktop");
  listed.list.mockReset().mockResolvedValue(FILES);
});

afterEach(() => {
  useDawStore.setState({ guestMode: null });
});

describe("GuestDeliver files", () => {
  it("shows an Editor the files grouped, as links through the review route", async () => {
    asGuest("edit");
    render(<GuestDeliver />);
    expect(
      await screen.findByRole("heading", { name: "Files" }),
    ).toBeInTheDocument();
    const mp3 = await screen.findByRole("link", { name: /^Download ep\.mp3/ });
    expect(mp3.getAttribute("href")).toMatch(
      /\/api\/review\/tok123\/daw\/export\/files\/ep\.mp3$/,
    );
    for (const group of ["Audio", "Transcript", "Chapters"]) {
      expect(screen.getAllByText(group).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("button", { name: /^Reveal/ })).toBeNull();
    expect(screen.queryByText("Download all")).toBeNull();
  });

  it("says so when the host has exported nothing yet", async () => {
    listed.list.mockResolvedValue([]);
    asGuest("edit");
    render(<GuestDeliver />);
    expect(
      await screen.findByText("No exported files yet. Ask the host to export."),
    ).toBeInTheDocument();
  });

  it.each(["comment", "view"] as const)(
    "shows a %s link no files and asks the server for none",
    (mode) => {
      asGuest(mode);
      render(<GuestDeliver />);
      expect(screen.queryByRole("heading", { name: "Files" })).toBeNull();
      expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
      expect(listed.list).not.toHaveBeenCalled();
    },
  );
});
