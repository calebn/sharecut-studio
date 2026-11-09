import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { NEVER, SETTINGS, TOTAL } from "./deliverFixture";
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
