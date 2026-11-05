import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { deferred } from "../../test/deferred";
import { useTranscriptFlow } from "./useTranscriptFlow";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  exportTranscript: vi.fn(),
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

type HookProps = {
  projectPath: string;
  revision: number;
  projectEpoch?: number;
};
type TranscriptResponse = Awaited<ReturnType<typeof api.exportTranscript>>;

function mount(props: HookProps) {
  return renderHook(
    (p: HookProps) =>
      useTranscriptFlow({
        ...p,
        projectEpoch: p.projectEpoch ?? 0,
        enabled: true,
        hasTranscript: true,
      }),
    { initialProps: props },
  );
}

describe("useTranscriptFlow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.mocked(api.exportTranscript).mockReset();
    vi.mocked(api.exportTranscript).mockResolvedValue(written);
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
    expect(result.current.written).toBe(1);
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
        projectEpoch: 0,
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

  it("resets choices and copy state on a project switch", async () => {
    const { result, rerender } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    act(() => result.current.setChoices(["txt"]));
    expect(result.current.choices).toEqual(["txt"]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.mocked(api.exportTranscript).mockResolvedValueOnce({
      ...written,
      text: "Maya: Hi.",
    });
    act(() => result.current.copyText());
    await waitFor(() => expect(result.current.copyState).toBe("copied"));
    vi.mocked(api.exportTranscript).mockReturnValue(new Promise(() => {}));
    rerender({ projectPath: "/b", revision: 1 });
    await waitFor(() => expect(result.current.preview.kind).toBe("loading"));
    expect(result.current.choices).toEqual(["md", "srt"]);
    expect(result.current.copyState).toBe("idle");
    expect(result.current.preview.kind).toBe("loading");
  });

  it("aborts the in-flight preview when the transcript changes", async () => {
    let finish: (v: typeof written) => void = () => {};
    vi.mocked(api.exportTranscript).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { result, rerender } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(api.exportTranscript).toHaveBeenCalledTimes(1));
    const first = vi.mocked(api.exportTranscript).mock.calls[0][2]?.signal;
    expect(first?.aborted).toBe(false);
    rerender({ projectPath: "/a", revision: 2 });
    expect(first?.aborted).toBe(true);
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
    await act(async () =>
      finish({
        ...written,
        preview: [{ speaker: "Maya", start_sec: 0, text: "Late." }],
      }),
    );
    const preview = result.current.preview;
    expect(preview.kind === "ready" && preview.preview.shown[0].text).toBe(
      "Hi.",
    );
  });

  it("recovers from a failed preview when reloaded", async () => {
    vi.mocked(api.exportTranscript).mockRejectedValueOnce(new Error("offline"));
    const { result } = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() =>
      expect(result.current.preview).toEqual({
        kind: "failed",
        cause: "offline",
      }),
    );
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.preview.kind).toBe("ready"));
  });
  it("accepts just one write from two commands before React rerenders", async () => {
    const hook = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(hook.result.current.preview.kind).toBe("ready"));
    const write = deferred<TranscriptResponse>();
    vi.mocked(api.exportTranscript).mockReturnValueOnce(write.promise);
    act(() => {
      hook.result.current.exportNow();
      hook.result.current.exportNow();
    });
    expect(
      vi
        .mocked(api.exportTranscript)
        .mock.calls.filter(([, request]) => !request.dry_run),
    ).toHaveLength(1);
    await act(async () => write.resolve(written));
  });

  it.each(["success", "failure"] as const)(
    "rejects an old write %s after returning to the same project path",
    async (outcome) => {
      const hook = mount({ projectPath: "/a", revision: 1 });
      await waitFor(() =>
        expect(hook.result.current.preview.kind).toBe("ready"),
      );
      const write = deferred<TranscriptResponse>();
      vi.mocked(api.exportTranscript).mockReturnValueOnce(write.promise);
      act(() => hook.result.current.exportNow());
      hook.rerender({ projectPath: "/b", revision: 1 });
      hook.rerender({ projectPath: "/a", revision: 1 });
      await waitFor(() =>
        expect(hook.result.current.preview.kind).toBe("ready"),
      );
      await act(async () => {
        if (outcome === "success") write.resolve(written);
        else write.reject(new Error("retired write"));
      });
      expect(hook.result.current.run.phase).toBe("idle");
      expect(hook.result.current.written).toBe(0);
    },
  );

  it("does not replace a newer copy failure with an older successful copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const hook = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(hook.result.current.preview.kind).toBe("ready"));
    const oldText = deferred<TranscriptResponse>();
    vi.mocked(api.exportTranscript)
      .mockReturnValueOnce(oldText.promise)
      .mockRejectedValueOnce(new Error("latest text unavailable"));
    act(() => hook.result.current.copyText());
    act(() => hook.result.current.copyText());
    await waitFor(() => expect(hook.result.current.copyState).toBe("failed"));
    await act(async () =>
      oldText.resolve({ ...written, text: "Earlier copy." }),
    );
    expect(hook.result.current.copyState).toBe("failed");
  });

  it("starts the native clipboard write synchronously before transcript text arrives", async () => {
    class Item {
      readonly data: Record<string, Promise<Blob>>;
      constructor(data: Record<string, Promise<Blob>>) {
        this.data = data;
      }
    }
    vi.stubGlobal("ClipboardItem", Item);
    const copied = deferred();
    const write = vi.fn().mockReturnValue(copied.promise);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    const hook = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(hook.result.current.preview.kind).toBe("ready"));
    const text = deferred<TranscriptResponse>();
    vi.mocked(api.exportTranscript).mockReturnValueOnce(text.promise);
    act(() => {
      hook.result.current.copyText();
      expect(write).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      text.resolve({ ...written, text: "Maya: Hi." });
      copied.resolve();
    });
    expect(hook.result.current.copyState).toBe("copied");
  });

  it("retains the preview while waiting the unchanged refresh debounce", async () => {
    const hook = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(hook.result.current.preview.kind).toBe("ready"));
    vi.useFakeTimers();
    const preview = hook.result.current.preview;
    hook.rerender({ projectPath: "/a", revision: 2 });
    expect(hook.result.current.preview).toBe(preview);
    await act(async () => vi.advanceTimersByTimeAsync(299));
    expect(api.exportTranscript).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.exportTranscript).toHaveBeenCalledTimes(2);
  });
  it("does not carry a running write into the next document epoch at the same path", async () => {
    const hook = mount({ projectPath: "/a", revision: 1, projectEpoch: 0 });
    await waitFor(() => expect(hook.result.current.preview.kind).toBe("ready"));
    const write = deferred<TranscriptResponse>();
    vi.mocked(api.exportTranscript).mockReturnValueOnce(write.promise);
    act(() => hook.result.current.exportNow());
    hook.rerender({ projectPath: "/a", revision: 1, projectEpoch: 1 });
    expect(hook.result.current.run.phase).toBe("idle");
    await act(async () => write.resolve(written));
    expect(hook.result.current.run.phase).toBe("idle");
    expect(hook.result.current.written).toBe(0);
  });

  it("does not let an older copied acknowledgement timer erase a newer failure", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const hook = mount({ projectPath: "/a", revision: 1 });
    await waitFor(() => expect(hook.result.current.preview.kind).toBe("ready"));
    vi.useFakeTimers();
    vi.mocked(api.exportTranscript).mockResolvedValueOnce({
      ...written,
      text: "Maya: Hi.",
    });
    await act(async () => hook.result.current.copyText());
    expect(hook.result.current.copyState).toBe("copied");
    vi.mocked(api.exportTranscript).mockRejectedValueOnce(
      new Error("new text unavailable"),
    );
    await act(async () => hook.result.current.copyText());
    expect(hook.result.current.copyState).toBe("failed");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(hook.result.current.copyState).toBe("failed");
  });
});
