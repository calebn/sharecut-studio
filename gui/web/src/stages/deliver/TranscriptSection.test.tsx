import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { TranscriptSection } from "./TranscriptSection";
import {
  SAMPLE_FILES,
  transcriptOptions,
  transcriptRows,
} from "./transcriptFixtures";

const button = (name: string | RegExp) => screen.getByRole("button", { name });

const staleRows = (name = "episode.md") => {
  const rows = transcriptRows();
  return {
    ...rows,
    files: rows.files
      .filter((f) => f.name === name)
      .map((f) => ({ ...f, current: false })),
  };
};

describe("TranscriptSection", () => {
  it("previews turns and exports the chosen formats", async () => {
    const onExport = vi.fn();
    const { container } = render(
      <TranscriptSection options={transcriptOptions({ onExport })} />,
    );
    expect(screen.getByText(/editing by text/)).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 212 turns/)).toBeInTheDocument();
    expect(button("Markdown")).toHaveAttribute("aria-pressed", "true");
    expect(button("Text")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button("Export 2 files"));
    expect(onExport).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("toggles a format in chip order", async () => {
    const onChoices = vi.fn();
    render(<TranscriptSection options={transcriptOptions({ onChoices })} />);
    await userEvent.click(button("Text"));
    expect(onChoices).toHaveBeenCalledWith(["txt", "md", "srt"]);
  });

  it("blocks export and copy when no format is chosen", () => {
    render(<TranscriptSection options={transcriptOptions({ choices: [] })} />);
    expect(button("Export")).toBeDisabled();
    expect(
      screen.getAllByText("Choose at least one format.").length,
    ).toBeGreaterThan(0);
  });

  it("offers Prepare when nothing is transcribed", async () => {
    const onPrepare = vi.fn();
    render(
      <TranscriptSection
        options={transcriptOptions({ preview: { kind: "none" }, onPrepare })}
      />,
    );
    await userEvent.click(button("Go to Prepare"));
    expect(onPrepare).toHaveBeenCalledOnce();
  });

  it("says nothing can be exported when every word is cut", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({ preview: { kind: "allCut" } })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Every word is cut");
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
  });

  it("shows a load failure with retry", async () => {
    const onRetry = vi.fn();
    render(
      <TranscriptSection
        options={transcriptOptions({
          preview: { kind: "failed", cause: "Backend offline" },
          onRetry,
        })}
      />,
    );
    expect(screen.getByText("Backend offline")).toBeInTheDocument();
    await userEvent.click(button("Try again"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows a skeleton while loading", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({ preview: { kind: "loading" } })}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each(["page", "preview"] as const)(
    "retries a slow transcript load once when %s is loading",
    (loading) => {
      vi.useFakeTimers();
      let unmount: (() => void) | undefined;
      try {
        const onRetry = vi.fn();
        ({ unmount } = render(
          <TranscriptSection
            state={loading === "page" ? "loading" : "ready"}
            options={transcriptOptions({
              ...(loading === "preview"
                ? { preview: { kind: "loading" as const } }
                : {}),
              onRetry,
            })}
          />,
        ));
        act(() => {
          vi.advanceTimersByTime(3999);
        });
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(screen.getByRole("status")).toHaveTextContent("Still loading");
        expect(onRetry).not.toHaveBeenCalled();
        fireEvent.click(button("Retry"));
        expect(onRetry).toHaveBeenCalledOnce();
      } finally {
        unmount?.();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("disables export while writing", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({ run: { phase: "writing" } })}
      />,
    );
    expect(screen.getByText("Writing")).toBeInTheDocument();
    expect(button("Export 2 files")).toBeDisabled();
  });

  it("lists the written files when done", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({
          run: { phase: "done", files: SAMPLE_FILES },
        })}
        files={transcriptRows()}
      />,
    );
    expect(screen.getByText("Exported")).toBeInTheDocument();
    expect(screen.getByText("episode.srt")).toBeInTheDocument();
  });

  it("flags files edited since export and offers Export again", () => {
    render(
      <TranscriptSection
        options={transcriptOptions()}
        files={{
          ...transcriptRows(),
          files: transcriptRows()
            .files.slice(0, 1)
            .map((f) => ({
              ...f,
              current: false,
            })),
        }}
      />,
    );
    expect(screen.getAllByText("Edited since export")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "Download episode.md, 18 KB" }),
    ).toHaveAttribute("href", "#episode.md");
    expect(button("Export 2 files again")).toBeEnabled();
  });

  it("reports a failed export and retries through Export", async () => {
    const onExport = vi.fn();
    render(
      <TranscriptSection
        options={transcriptOptions({
          run: { phase: "failed", cause: "Disk full" },
          onExport,
        })}
      />,
    );
    expect(screen.getByText("Disk full")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await userEvent.click(button("Export 2 files"));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it("ignores an outdated file of an unticked format", () => {
    render(
      <TranscriptSection
        options={transcriptOptions()}
        files={{
          ...transcriptRows(),
          files: [
            {
              id: "episode.txt",
              name: "episode.txt",
              kind: "transcript",
              label: "Text",
              bytes: 900,
              current: false,
              href: "#episode.txt",
            },
          ],
        }}
      />,
    );
    expect(screen.getAllByText("Edited since export")).toHaveLength(1);
    expect(button("Export 2 files")).toBeEnabled();
  });

  it("does not offer Export again once the run is done", () => {
    const { container } = render(
      <TranscriptSection
        options={transcriptOptions({
          run: { phase: "done", files: SAMPLE_FILES },
        })}
        files={staleRows()}
      />,
    );
    expect(container.querySelector(".sys-status-title")).toHaveTextContent(
      "Exported",
    );
    expect(screen.getAllByText("Edited since export")).toHaveLength(1);
    expect(button("Export 2 files")).toBeInTheDocument();
  });

  it("keeps Export again disabled while writing outdated files", () => {
    const { container } = render(
      <TranscriptSection
        options={transcriptOptions({ run: { phase: "writing" } })}
        files={staleRows()}
      />,
    );
    const titles = Array.from(
      container.querySelectorAll(".sys-status-title"),
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Writing"]);
    expect(button("Export 2 files again")).toBeDisabled();
  });

  it("names the blocker ahead of a running export", () => {
    const { rerender } = render(
      <TranscriptSection
        options={transcriptOptions({ choices: [], exportRunning: true })}
      />,
    );
    expect(screen.getAllByText("Choose at least one format.")).toHaveLength(1);
    expect(
      screen.queryByText("An export is running. It writes the transcript too."),
    ).toBeNull();
    rerender(
      <TranscriptSection
        options={transcriptOptions({
          run: { phase: "writing" },
          exportRunning: true,
        })}
      />,
    );
    expect(screen.getAllByText("Writing the transcript now.")).toHaveLength(1);
    rerender(
      <TranscriptSection
        options={transcriptOptions({
          preview: { kind: "allCut" },
          exportRunning: true,
        })}
      />,
    );
    expect(
      screen.getAllByText("Every word is cut. Nothing to export."),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
  });

  it("copies and reports the blocked clipboard", async () => {
    const onCopy = vi.fn();
    const { rerender } = render(
      <TranscriptSection options={transcriptOptions({ onCopy })} />,
    );
    await userEvent.click(button("Copy text"));
    expect(onCopy).toHaveBeenCalledOnce();
    rerender(
      <TranscriptSection
        options={transcriptOptions({ onCopy, copyState: "blocked" })}
      />,
    );
    expect(button("Copy blocked")).toBeInTheDocument();
    expect(screen.getByText(/browser blocked copying/)).toBeInTheDocument();
  });

  it("moves focus to Export once when requested", () => {
    const onFocused = vi.fn();
    render(
      <TranscriptSection
        options={transcriptOptions({ focusRequested: true, onFocused })}
      />,
    );
    expect(button("Export 2 files")).toHaveFocus();
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("shows fewer turns on the compact layout", () => {
    const preview = transcriptOptions().preview;
    if (preview.kind !== "ready") throw new Error("fixture");
    const many = {
      kind: "ready" as const,
      preview: {
        ...preview.preview,
        shown: Array.from({ length: 6 }, (_, i) => ({
          ...preview.preview.shown[0],
          startSec: i * 10,
        })),
      },
    };
    render(
      <TranscriptSection
        compact
        options={transcriptOptions({ preview: many })}
      />,
    );
    expect(screen.getAllByRole("listitem").length).toBe(4);
  });

  it("says so when the text could not be read for Copy", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({ copyState: "failed" })}
      />,
    );
    expect(
      screen.getByText(/Could not read the transcript/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/browser blocked copying/)).toBeNull();
  });

  it("keeps the focus request until the Export button exists", () => {
    const onFocused = vi.fn();
    const { rerender } = render(
      <TranscriptSection
        options={transcriptOptions({
          preview: { kind: "loading" },
          focusRequested: true,
          onFocused,
        })}
      />,
    );
    expect(onFocused).not.toHaveBeenCalled();
    rerender(
      <TranscriptSection
        options={transcriptOptions({ focusRequested: true, onFocused })}
      />,
    );
    expect(button("Export 2 files")).toHaveFocus();
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("drops the focus request when there is no Export button to focus", () => {
    const onFocused = vi.fn();
    render(
      <TranscriptSection
        options={transcriptOptions({
          preview: { kind: "none" },
          focusRequested: true,
          onFocused,
        })}
      />,
    );
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("focuses the first enabled button when Export is disabled", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({
          choices: [],
          focusRequested: true,
        })}
      />,
    );
    expect(button("Text")).toHaveFocus();
  });

  it("explains an audio export in progress and blocks Export", () => {
    render(
      <TranscriptSection
        options={transcriptOptions({ exportRunning: true })}
      />,
    );
    expect(button("Export 2 files")).toBeDisabled();
    expect(screen.getAllByText(/An export is running/).length).toBeGreaterThan(
      0,
    );
  });

  it("shows the caption cue only while SRT or VTT is chosen", () => {
    const { rerender } = render(
      <TranscriptSection options={transcriptOptions()} />,
    );
    expect(
      screen.getByText(/Welcome back to the show\./, {
        selector: "p.dv-tx-cue",
      }),
    ).toBeInTheDocument();
    rerender(
      <TranscriptSection options={transcriptOptions({ choices: ["md"] })} />,
    );
    expect(document.querySelector(".dv-tx-cue")).toBeNull();
  });
});
