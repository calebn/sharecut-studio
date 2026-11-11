import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  DONE,
  exportedFilesOf,
  NEVER,
  REQUEST,
  SETTINGS,
  STALE,
  TOTAL,
} from "./deliverFixture";
import type { EpisodeSettings } from "./deliverLogic";
import { EpisodeFile } from "./EpisodeFile";

it.each([{ remaining: [] }, { remaining: ["mp3"] }])(
  "keeps a missing choice removable before exporting remaining $remaining",
  async ({ remaining }) => {
    const onExport = vi.fn();
    function Controlled() {
      const [settings, setSettings] = useState<EpisodeSettings>({
        ...SETTINGS,
        formats: ["opus", ...remaining],
      });
      return (
        <EpisodeFile
          settings={settings}
          total={TOTAL}
          exportState={NEVER}
          hasTranscriptSection={false}
          onSettings={setSettings}
          onExport={onExport}
          options={{
            formats: [{ id: "mp3", label: "MP3", bytesPerSecond: 16000 }],
            wavAlwaysWritten: true,
            range: false,
          }}
        />
      );
    }
    const { container } = render(<Controlled />);
    const missing = screen.getByRole("button", { name: "OPUS · unavailable" });
    expect(missing).toHaveAttribute("aria-pressed", "true");
    expect(missing).toHaveTextContent(/^OPUS · unavailable$/);
    expect(missing).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(
      screen.getByText("Remove unavailable formats before exporting."),
    ).toBeVisible();
    await expectNoA11yViolations(container);
    await userEvent.click(missing);
    expect(
      screen.queryByRole("button", { name: "OPUS · unavailable" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /^MP3/ })).toHaveAttribute(
      "aria-pressed",
      String(remaining.length > 0),
    );
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  },
);

const renderAfter = (
  state: typeof DONE | typeof STALE,
  access: "reveal" | "download",
  extra: { onReveal?: () => void; onStarted?: () => void } = {},
) =>
  render(
    <EpisodeFile
      settings={SETTINGS}
      total={TOTAL}
      exportState={state}
      files={{ ...exportedFilesOf(REQUEST, access), ...extra }}
      hasTranscriptSection={false}
      onSettings={() => {}}
      onExport={() => {}}
    />,
  );

it("makes Reveal in Finder the primary after an export and keeps Export as a quiet again", async () => {
  const onReveal = vi.fn();
  renderAfter(DONE, "reveal", { onReveal });
  const reveal = screen.getByRole("button", { name: "Reveal in Finder" });
  expect(reveal).toHaveClass("primary");
  const again = screen.getByRole("button", { name: "Export again" });
  expect(again).not.toHaveClass("primary");
  await userEvent.click(reveal);
  expect(onReveal).toHaveBeenCalledTimes(1);
  expect(onReveal.mock.calls[0]?.[0]).toMatchObject({ kind: "audio" });
});

it("makes Download the primary after a browser export and downloads the main file", async () => {
  const onStarted = vi.fn();
  renderAfter(DONE, "download", { onStarted });
  const link = screen.getByRole("link", { name: "Download" });
  expect(link).toHaveClass("primary");
  expect(link).toHaveAttribute("download");
  expect(screen.getByRole("button", { name: "Export again" })).not.toHaveClass(
    "primary",
  );
  expect(
    screen.getAllByRole("link", { name: /^Download / }).length,
  ).toBeGreaterThan(1);
});

it("keeps Export the primary when the export is stale or never ran", () => {
  const { unmount } = renderAfter(STALE, "reveal");
  expect(screen.getByRole("button", { name: "Export" })).toHaveClass("primary");
  expect(screen.queryByRole("button", { name: "Reveal in Finder" })).toBeNull();
  unmount();
  render(
    <EpisodeFile
      settings={SETTINGS}
      total={TOTAL}
      exportState={NEVER}
      hasTranscriptSection={false}
      onSettings={() => {}}
      onExport={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Export" })).toHaveClass("primary");
});
