import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { ExportedFiles } from "./ExportedFiles";
import type { ExportedFile } from "./exportedFileModel";

const files: ExportedFile[] = [
  {
    id: "episode.wav",
    name: "episode.wav",
    kind: "audio",
    label: "Master",
    bytes: 1024,
    current: true,
    href: "/api/export/files/episode.wav?ticket=canonical",
  },
  {
    id: "opaque:a#1",
    name: "broadcast.mp3",
    kind: "audio",
    label: "Broadcast (-23 LUFS) · MP3",
    bytes: 512,
    current: false,
    href: "/api/export/files/opaque%3Aa%231?ticket=ticket-Broadcast",
  },
  {
    id: "episode.chapters.json",
    name: "episode.chapters.json",
    kind: "chapters",
    label: "Chapters",
    bytes: 128,
    current: false,
    href: "/api/export/files/episode.chapters.json?ticket=chapters",
  },
];

describe("ExportedFiles", () => {
  it("keeps every folder row without attributing stale audio to an edit", async () => {
    const { container } = render(
      <ExportedFiles files={files} access="download" grouped />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Master");
    expect(rows[0]).not.toHaveTextContent("out of date");
    expect(rows[0]).not.toHaveTextContent("Edited since export");
    expect(rows[1]).toHaveTextContent("Broadcast (-23 LUFS) · MP3");
    expect(rows[1]).toHaveTextContent("Export is out of date");
    expect(rows[1]).not.toHaveTextContent("Edited since export");
    expect(rows[2]).toHaveTextContent("Edited since export");
    expect(within(rows[1]!).getByRole("link")).toHaveAttribute(
      "href",
      "/api/export/files/opaque%3Aa%231?ticket=ticket-Broadcast",
    );
    expect(within(rows[1]!).getByRole("link")).toHaveAttribute(
      "download",
      "broadcast.mp3",
    );
    await expectNoA11yViolations(container);
  });

  it("reveals the exact stale audio row and retains an explicit label override", async () => {
    const onReveal = vi.fn();
    render(
      <ExportedFiles
        files={files}
        access="reveal"
        staleLabel="Saved earlier"
        onReveal={onReveal}
      />,
    );
    expect(screen.getAllByText("Saved earlier")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("button", { name: /^Reveal broadcast.mp3,/ }),
    );
    expect(onReveal).toHaveBeenCalledWith(files[1]);
  });
});
