import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  DONE,
  exportedFilesOf,
  NEVER,
  REQUEST,
  RUNNING,
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
  state: typeof DONE | typeof STALE | typeof RUNNING,
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

it("makes Reveal in folder the primary after an export and keeps Export as a quiet again", async () => {
  const onReveal = vi.fn();
  renderAfter(DONE, "reveal", { onReveal });
  const reveal = screen.getByRole("button", { name: "Reveal in folder" });
  expect(reveal).toHaveClass("primary");
  const again = screen.getByRole("button", { name: "Export again" });
  expect(again).not.toHaveClass("primary");
  await userEvent.click(reveal);
  expect(onReveal).toHaveBeenCalledTimes(1);
  expect(onReveal.mock.calls[0]?.[0]).toMatchObject({ kind: "audio" });
});

it("keeps the file primary while an export runs again", () => {
  renderAfter(RUNNING, "reveal");
  expect(screen.getByRole("button", { name: "Reveal in folder" })).toHaveClass(
    "primary",
  );
  expect(screen.getByRole("button", { name: "Export again" })).toBeDisabled();
});

it("makes Download the primary after a browser export and downloads the main file", async () => {
  const onStarted = vi.fn();
  renderAfter(DONE, "download", { onStarted });
  const link = screen.getByRole("link", { name: /^Download main file/ });
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
  expect(screen.queryByRole("button", { name: "Reveal in folder" })).toBeNull();
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

const BOUNCE = {
  id: "bounces/field-notes_0-3.wav",
  name: "field-notes_0-3.wav",
  kind: "bounce" as const,
  label: "Unmastered export",
  bytes: 1_200_000,
  current: true,
};

const renderWithBounce = (
  access: "reveal" | "download",
  withBounce: boolean,
  onReveal?: () => void,
) => {
  const base = exportedFilesOf(REQUEST, access);
  render(
    <EpisodeFile
      settings={SETTINGS}
      total={TOTAL}
      exportState={DONE}
      files={{
        ...base,
        onReveal,
        files: withBounce
          ? [
              ...base.files,
              {
                ...BOUNCE,
                href: access === "download" ? `#${BOUNCE.id}` : undefined,
              },
            ]
          : base.files,
      }}
      hasTranscriptSection={false}
      onSettings={() => {}}
      onExport={() => {}}
    />,
  );
};

it("lists a selection export under its own group with Download in the browser", () => {
  renderWithBounce("download", true);
  const group = screen
    .getByRole("heading", { name: "Exports of a selection" })
    .closest(".dv-file-group") as HTMLElement;
  expect(within(group).getByText("Unmastered export")).toBeVisible();
  expect(
    within(group).getByRole("link", { name: /^Download field-notes_0-3\.wav/ }),
  ).toHaveAttribute("download");
});

it("reveals a selection export in the desktop app", async () => {
  const onReveal = vi.fn();
  renderWithBounce("reveal", true, onReveal);
  await userEvent.click(
    screen.getByRole("button", { name: /^Reveal field-notes_0-3\.wav/ }),
  );
  expect(onReveal.mock.calls[0]?.[0]).toMatchObject({ kind: "bounce" });
});

it("shows no selection group when nothing was exported from a selection", () => {
  renderWithBounce("download", false);
  expect(
    screen.queryByRole("heading", { name: "Exports of a selection" }),
  ).toBeNull();
});
