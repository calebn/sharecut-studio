import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  failed: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  readGuestExportedFiles: listed.list,
  startGuestExport: listed.start,
  guestExportFailed: listed.failed,
}));
vi.mock("../../stages/deliver/FeedPanel", () => ({ FeedPanel: () => null }));

import { EditorCutTotal } from "../../hooks/useEditorCutTotal";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ApiError } from "../../utils/apiError";
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

const ARCHIVE = { name: "ep-export.zip", count: 3, bytes: 5_000_300 };

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
  listed.list.mockReset().mockResolvedValue({
    inventory: { files: FILES, archive: ARCHIVE },
    revision: "first",
    exporting: false,
    guestRender: true,
  });
  listed.start.mockReset().mockResolvedValue(undefined);
  listed.failed.mockReset().mockResolvedValue(false);
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
    const all = screen.getByRole("link", { name: /^Download all 3 files/ });
    expect(all.getAttribute("href")).toMatch(
      /\/api\/review\/tok123\/daw\/export\/archive$/,
    );
    expect(all).toHaveTextContent("Download all");
    expect(all).not.toHaveClass("primary");
    expect(all.getAttribute("href")).not.toContain("ticket");
    expect(screen.queryByRole("combobox", { name: "DAW format" })).toBeNull();
  });

  it("offers no Download all when the host lists no current file to pack", async () => {
    listed.list.mockResolvedValue({
      inventory: { files: FILES, archive: null },
      revision: "first",
    });
    asGuest("edit");
    render(<GuestDeliver />);
    await screen.findByRole("link", { name: /^Download ep\.mp3/ });
    expect(screen.queryByRole("link", { name: /^Download all/ })).toBeNull();
  });

  it("says so when the host has exported nothing yet", async () => {
    listed.list.mockResolvedValue({
      inventory: { files: [], archive: null },
      revision: "first",
    });
    asGuest("edit");
    render(<GuestDeliver />);
    expect(
      await screen.findByText(
        "No exported files yet. Use Export to make them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("sends the Editor to the host instead when exports from share links are off", async () => {
    listed.list.mockResolvedValue({
      inventory: { files: [], archive: null },
      revision: "first",
      exporting: false,
      guestRender: false,
    });
    asGuest("edit");
    render(<GuestDeliver />);
    expect(
      await screen.findByText("No exported files yet. Ask the host to export."),
    ).toBeInTheDocument();
  });

  it("shows the Editor a pending listing and a retry after a failure", async () => {
    let rejectListing!: (reason: Error) => void;
    listed.list.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectListing = reject;
        }),
    );
    asGuest("edit");
    render(<GuestDeliver />);

    expect(screen.getByText("Loading exported files…")).toBeInTheDocument();
    expect(screen.queryByText(/^No exported files yet/)).toBeNull();
    rejectListing(new Error("Internal listing error"));
    expect(
      await screen.findByText("Exported files could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Internal listing error")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Retry loading exported files" }),
    );
    expect(
      await screen.findByRole("link", { name: /^Download ep\.mp3/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Exported files could not be loaded."),
    ).toBeNull();
    expect(listed.list).toHaveBeenCalledTimes(2);
  });

  it("disables the rows and Download all with the note while an export runs", async () => {
    listed.list.mockResolvedValue({
      inventory: { files: FILES, archive: ARCHIVE },
      revision: "first",
      exporting: true,
    });
    asGuest("edit");
    render(<GuestDeliver />);

    const mp3 = await screen.findByRole("button", {
      name: /^Download ep\.mp3/,
    });
    expect(mp3).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /^Download all 3 files/ }),
    ).toBeDisabled();
    expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
    expect(
      screen.getAllByText("Exporting now. Download when it finishes.").length,
    ).toBeGreaterThan(0);
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

describe("GuestDeliver export", () => {
  const exportButton = () => screen.getByRole("button", { name: "Export" });

  it("gives an Editor an Export button and says what it replaces", async () => {
    asGuest("edit");
    render(<GuestDeliver />);
    await screen.findByRole("link", { name: /^Download ep\.mp3/ });
    expect(exportButton()).toBeEnabled();
    expect(
      screen.getByText(
        "Export replaces files with the same name, including the feed.",
      ),
    ).toBeInTheDocument();
  });

  it.each(["comment", "view"] as const)("shows a %s link no Export", (mode) => {
    asGuest(mode);
    render(<GuestDeliver />);
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByText(/replaces files with the same name/)).toBeNull();
  });

  it("disables Export with the reason when the host has not turned exports on", async () => {
    listed.list.mockResolvedValue({
      inventory: { files: FILES, archive: ARCHIVE },
      revision: "first",
      exporting: false,
      guestRender: false,
    });
    asGuest("edit");
    render(<GuestDeliver />);
    await screen.findByRole("link", { name: /^Download ep\.mp3/ });
    expect(exportButton()).toBeDisabled();
    expect(
      screen.getByText("The host has not turned on exports from share links."),
    ).toBeInTheDocument();
    await userEvent.click(exportButton());
    expect(listed.start).not.toHaveBeenCalled();
  });

  it("disables Export with the reason while an export runs", async () => {
    listed.list.mockResolvedValue({
      inventory: { files: FILES, archive: ARCHIVE },
      revision: "first",
      exporting: true,
      guestRender: true,
    });
    asGuest("edit");
    render(<GuestDeliver />);
    await screen.findByRole("button", { name: /^Download ep\.mp3/ });
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute(
      "title",
      "Exporting now. Download when it finishes.",
    );
  });

  it("starts one export, shows Starting export. until the files read settles, then Exporting now.", async () => {
    let finishRead!: (value: unknown) => void;
    asGuest("edit");
    render(<GuestDeliver />);
    await screen.findByRole("link", { name: /^Download ep\.mp3/ });

    listed.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    await userEvent.dblClick(exportButton());
    expect(listed.start).toHaveBeenCalledTimes(1);
    expect(listed.start).toHaveBeenCalledWith(shareProjectKey("tok123"));
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText("Starting export.")).toBeInTheDocument();

    finishRead({
      inventory: { files: FILES, archive: ARCHIVE },
      revision: "second",
      exporting: true,
      guestRender: true,
    });
    expect(
      (await screen.findAllByText("Exporting now. Download when it finishes."))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Starting export.")).toBeNull();
  });

  it.each([
    [409, "job_running", "Another job is running. Try again shortly."],
    [
      403,
      "share_capability_required",
      "Exports from this link are not allowed.",
    ],
    [429, null, "Too many requests. Try again soon."],
  ])(
    "shows fixed copy for a %s refusal and keeps Export usable",
    async (status, code, copy) => {
      listed.start.mockRejectedValueOnce(
        new ApiError("host words that must not show", code, status),
      );
      asGuest("edit");
      render(<GuestDeliver />);
      await screen.findByRole("link", { name: /^Download ep\.mp3/ });
      await userEvent.click(exportButton());
      expect(await screen.findByText(copy)).toBeInTheDocument();
      expect(screen.queryByText("host words that must not show")).toBeNull();
      expect(exportButton()).toBeEnabled();
    },
  );

  it("says a failed export did not finish, with fixed copy", async () => {
    listed.failed.mockResolvedValue(true);
    asGuest("edit");
    render(<GuestDeliver />);
    await screen.findByRole("link", { name: /^Download ep\.mp3/ });
    await userEvent.click(exportButton());
    expect(
      await screen.findByText(
        "The export did not finish. Try again, or ask the host.",
      ),
    ).toBeInTheDocument();
    expect(listed.failed).toHaveBeenCalledTimes(1);
  });
});

describe("GuestDeliver cut total", () => {
  it.each([
    [0, "No cuts yet"],
    [3.2, "Edits saved 3.2 s shorter"],
    [72, "Edits saved 1 min 12 s shorter"],
  ])("words a total of %s s as %s", async (seconds, text) => {
    asGuest("edit");
    render(
      <EditorCutTotal.Provider value={seconds}>
        <GuestDeliver />
      </EditorCutTotal.Provider>,
    );
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("shows no cut line while the total is unknown", async () => {
    asGuest("edit");
    render(
      <EditorCutTotal.Provider value={null}>
        <GuestDeliver />
      </EditorCutTotal.Provider>,
    );
    await screen.findByRole("heading", { name: "Files" });
    expect(screen.queryByText(/Edits saved|No cuts yet/)).toBeNull();
  });
});
