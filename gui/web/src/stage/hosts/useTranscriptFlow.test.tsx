import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { useTranscriptFlow } from "./useTranscriptFlow";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  exportTranscript: vi.fn(),
  listExportedTranscripts: vi.fn(),
}));

const written = {
  language: "en",
  turns: 1,
  duration_sec: 3,
  preview: [{ speaker: "Maya", start_sec: 0, text: "Hi." }],
  cue_sample: null,
  files: [
    {
      format: "md" as const,
      path: "/a/episode.md",
      name: "episode.md",
      bytes: 5,
      language: "en",
      written: true,
      current: true,
    },
  ],
  text: null,
};

function mount(props: { projectPath: string; revision: number }) {
  return renderHook(
    (p: { projectPath: string; revision: number }) =>
      useTranscriptFlow({ ...p, enabled: true, hasTranscript: true }),
    { initialProps: props },
  );
}

describe("useTranscriptFlow", () => {
  beforeEach(() => {
    vi.mocked(api.exportTranscript).mockReset();
    vi.mocked(api.listExportedTranscripts).mockReset();
    vi.mocked(api.exportTranscript).mockResolvedValue(written);
    vi.mocked(api.listExportedTranscripts).mockResolvedValue([]);
  });

  it("drops a finished export once the transcript is edited", async () => {
    const { result, rerender } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    act(() => result.current.exportNow());
    await waitFor(() => expect(result.current.run.phase).toBe("done"));
    rerender({ projectPath: "/a", revision: 2 });
    await waitFor(() => expect(result.current.run.phase).toBe("idle"));
  });

  it("ignores an export that lands after a project switch", async () => {
    let finish: (v: typeof written) => void = () => {};
    const { result, rerender } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    vi.mocked(api.exportTranscript).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => result.current.exportNow());
    rerender({ projectPath: "/b", revision: 1 });
    await act(async () => finish(written));
    expect(result.current.run.phase).toBe("idle");
  });

  it("previews with a dry run and exports exactly the chosen formats", async () => {
    const { result } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    expect(api.exportTranscript).toHaveBeenCalledWith(
      "/a",
      { formats: ["md", "srt"], dry_run: true },
      expect.anything(),
    );
    act(() => result.current.setChoices(["txt"]));
    act(() => result.current.exportNow());
    await waitFor(() => expect(result.current.run.phase).toBe("done"));
    expect(api.exportTranscript).toHaveBeenLastCalledWith("/a", {
      formats: ["txt"],
    });
    await waitFor(() =>
      expect(api.listExportedTranscripts).toHaveBeenCalledTimes(2),
    );
  });

  it("reports a failed export", async () => {
    const { result } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    vi.mocked(api.exportTranscript).mockRejectedValueOnce(
      new Error("Disk full"),
    );
    act(() => result.current.exportNow());
    await waitFor(() => expect(result.current.run.phase).toBe("failed"));
  });

  it("copies the text, and says so when the text cannot be read", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { result } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    vi.mocked(api.exportTranscript).mockResolvedValueOnce({
      ...written,
      text: "Maya: Hi.",
    });
    act(() => result.current.copyText());
    await waitFor(() => expect(result.current.copyState).toBe("copied"));
    expect(writeText).toHaveBeenCalledWith("Maya: Hi.");
    vi.mocked(api.exportTranscript).mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.copyText());
    await waitFor(() => expect(result.current.copyState).toBe("failed"));
  });

  it("shows none without a transcript and fetches nothing", async () => {
    vi.mocked(api.exportTranscript).mockClear();
    const { result } = renderHook(() =>
      useTranscriptFlow({
        projectPath: "/a",
        enabled: true,
        hasTranscript: false,
        revision: 1,
      }),
    );
    await waitFor(() => expect(result.current.preview.kind).toBe("none"));
    expect(api.exportTranscript).not.toHaveBeenCalled();
  });

  it("does not report Exported when the transcript changed during the write", async () => {
    let finish: (v: typeof written) => void = () => {};
    const { result, rerender } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    vi.mocked(api.exportTranscript).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => result.current.exportNow());
    rerender({ projectPath: "/a", revision: 2 });
    await act(async () => finish(written));
    expect(result.current.run.phase).toBe("idle");
  });
});
