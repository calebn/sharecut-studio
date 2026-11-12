import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../../document/applyDocumentUpdate";
import {
  documentAuthority,
  documentScope,
  resetDocumentAuthority,
} from "../../document/authorityState";
import { noteDocumentSeq } from "../../document/cursor";
import {
  retryTranscriptDetail,
  scheduleTranscriptDetailHydrate,
  transcriptDetailSnapshot,
} from "../../document/hydrateTranscriptDetail";
import type { DocumentSnapshot } from "../../document/projectPatch";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleComment } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ReviewHost } from "./ReviewHost";

const { loadDetail } = vi.hoisted(() => ({ loadDetail: vi.fn() }));
vi.mock("../../api/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/project")>()),
  loadDocumentState: loadDetail,
}));

const TOKEN = "a".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function join(
  role: "comment" | "view",
  transcriptWordsLoaded: boolean,
  transcriptWords = true,
) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      comments: [sampleComment()],
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: transcriptWordsLoaded },
      },
    }),
    role,
    role === "comment" ? ["view", "comment", "suggest"] : ["view"],
    null,
    transcriptWords,
  );
  useDawStore.setState({ stage: "review" });
  resetDocumentAuthority("share:tok");
  const project = useDawStore.getState().project;
  if (!project) throw new Error("The guest project should be hydrated");
  documentAuthority.project = project;
  documentAuthority.token = TOKEN;
  documentAuthority.phase = { kind: "ready" };
  scheduleTranscriptDetailHydrate(useDawStore.getState().project);
}

describe("guest transcript detail loading in Review", () => {
  beforeEach(() => {
    resetDocumentAuthority();
    loadDetail.mockReset();
    loadDetail.mockImplementation(() => new Promise(() => undefined));
    localStorage.clear();
    stubViewportShell("desktop");
  });
  afterEach(() => {
    resetDocumentAuthority();
    vi.unstubAllGlobals();
  });
  it("keeps the Commenter Queue and composer usable while the Script waits, then shows settled empty copy", () => {
    join("comment", false);
    const { container } = render(<ReviewHost guestShare />);

    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();
    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).not.toBeNull();
    expect(
      screen.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();

    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("The guest project should be hydrated");
      useDawStore.setState({
        project: {
          ...project,
          meta: { name: "Test Episode", workspace_dir: "/tmp/test" },
        },
      });
    });

    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();
  });

  it("keeps the phone comments row usable beside the pending Script region", () => {
    stubViewportShell("phone");
    join("comment", false);
    const { container } = render(<ReviewHost guestShare />);

    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).not.toBeNull();
    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Show comments/ }),
    ).toBeEnabled();
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("hides the pending and failed Script slot at short height, then restores it with the same request", async () => {
    stubViewportShell("tablet");
    const visualViewport = Object.assign(new EventTarget(), {
      height: 400,
      width: 390,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", visualViewport);
    const first = deferred<{
      server_seq: number;
      state_token: string;
      project: ReturnType<typeof minimalProject>;
    }>();
    loadDetail.mockReturnValueOnce(first.promise);
    join("comment", false);
    const { container } = render(<ReviewHost guestShare />);

    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).toBeNull();
    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();

    act(() => {
      visualViewport.height = 600;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).not.toBeNull();
    expect(loadDetail).toHaveBeenCalledTimes(1);

    await act(async () => first.reject(new Error("private transport detail")));
    expect(screen.getByRole("alert")).toBeVisible();
    act(() => {
      visualViewport.height = 400;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();

    act(() => {
      visualViewport.height = 600;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("does not show a permanent loading region to a link that carries no words", () => {
    join("view", false, false);
    const { container } = render(<ReviewHost guestShare />);

    expect(screen.getAllByRole("region", { name: "Queue" })[0]).toBeVisible();
    expect(
      container.querySelector(".sys-skeleton[aria-busy='true']"),
    ).toBeNull();
    expect(
      screen.queryByText("The host has not made a transcript of this version."),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it("loads the transcript for a Viewer and mounts a read-only Script", async () => {
    const project = minimalProject({
      comments: [sampleComment()],
      transcript: {
        utterances: [
          {
            track_id: "t1",
            source_id: null,
            speaker: "Maya",
            start: 0,
            end: 1,
            text: "Welcome back",
            words: [
              {
                text: "Welcome",
                start: 0,
                end: 0.5,
                timeline_start: 0,
                timeline_end: 0.5,
                mappable: true,
                word_index: 0,
              },
              {
                text: "back",
                start: 0.5,
                end: 1,
                timeline_start: 0.5,
                timeline_end: 1,
                mappable: true,
                word_index: 1,
              },
            ],
          },
        ],
      },
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: true },
      },
    });
    const landed = deferred<DocumentSnapshot>();
    loadDetail.mockReturnValueOnce(landed.promise);
    join("view", false);
    render(<ReviewHost guestShare />);
    expect(loadDetail).toHaveBeenCalledTimes(1);

    await act(async () =>
      landed.resolve({
        server_seq: 0,
        state_token: TOKEN,
        project,
      }),
    );

    expect(await screen.findByText("Read only")).toBeVisible();
    expect(screen.getByRole("button", { name: "Welcome" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /suggest/i })).toBeNull();
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it.each(["complete", "unspecified"] as const)(
    "mounts the Viewer Script when hydration metadata is %s",
    (hydration) => {
      join("view", true);
      if (hydration === "unspecified") {
        const project = useDawStore.getState().project;
        if (!project) throw new Error("The guest project should be hydrated");
        useDawStore.setState({
          project: {
            ...project,
            meta: { name: "Test Episode", workspace_dir: "/tmp/test" },
          },
        });
      }
      render(<ReviewHost guestShare />);

      expect(
        screen.getByText("The host has not made a transcript of this version."),
      ).toBeVisible();
      expect(loadDetail).not.toHaveBeenCalled();
    },
  );

  it.each(["no drift", "newer reply", "rejection after sequence advances"])(
    "keeps the regional failure mounted and focused while retrying (%s), then mounts the Script",
    async (outcome) => {
      const first = deferred<DocumentSnapshot>();
      const retry = deferred<DocumentSnapshot>();
      const replacement = deferred<DocumentSnapshot>();
      loadDetail
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(retry.promise)
        .mockReturnValueOnce(replacement.promise);
      join("comment", false);
      render(<ReviewHost guestShare />);

      await act(async () =>
        first.reject(new Error("private transport detail")),
      );
      const failed = transcriptDetailSnapshot();
      expect(failed.kind).toBe("failed");
      const button = await screen.findByRole("button", { name: "Try again" });
      expect(screen.getByRole("alert")).toBeVisible();
      expect(screen.getByText("Try again in a moment.")).toBeVisible();
      expect(screen.queryByText("private transport detail")).toBeNull();

      await userEvent.setup().click(button);
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("alert")).toBeVisible();
      expect(loadDetail).toHaveBeenCalledTimes(2);
      if (failed.kind !== "failed")
        throw new Error("The first attempt should fail");
      retryTranscriptDetail(failed.attempt);
      expect(loadDetail).toHaveBeenCalledTimes(2);

      const complete = minimalProject({
        meta: {
          name: "Test Episode",
          workspace_dir: "/tmp/test",
          hydration: { transcript_words: true },
        },
      });
      const currentSeq =
        outcome === "rejection after sequence advances" ? 1 : 0;
      if (outcome !== "no drift") {
        await act(async () => {
          if (outcome === "newer reply") {
            retry.resolve({
              server_seq: 1,
              state_token: TOKEN,
              project: complete,
            });
          } else {
            noteDocumentSeq(currentSeq);
            retry.reject(new Error("private transport detail"));
          }
        });
        expect(loadDetail).toHaveBeenCalledTimes(3);
        expect(
          useDawStore.getState().project?.meta.hydration?.transcript_words,
        ).toBe(false);
        expect(button.isConnected).toBe(true);
        expect(screen.getByRole("button", { name: "Try again" })).toBe(button);
        expect(button).toHaveFocus();
        expect(button).toHaveAttribute("aria-busy", "true");
      }
      const successful = outcome === "no drift" ? retry : replacement;
      await act(async () =>
        successful.resolve({
          server_seq: currentSeq,
          state_token: TOKEN,
          project: complete,
        }),
      );
      expect(
        useDawStore.getState().project?.meta.hydration?.transcript_words,
      ).toBe(true);
      await waitFor(() =>
        expect(
          screen.getByText(
            "The host has not made a transcript of this version.",
          ),
        ).toBeVisible(),
      );
      expect(screen.getByRole("textbox", { name: "Comment" })).toBeEnabled();
      expect(button.isConnected).toBe(false);
    },
  );

  it("retries after a new accepted incomplete snapshot without dropping the focused Cover", async () => {
    const first = deferred<{
      server_seq: number;
      state_token: string;
      project: ReturnType<typeof minimalProject>;
    }>();
    loadDetail
      .mockReturnValueOnce(first.promise)
      .mockImplementation(() => new Promise(() => undefined));
    join("comment", false);
    render(<ReviewHost guestShare />);

    await act(async () => first.reject(new Error("private transport detail")));
    const alert = await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();

    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("The guest project should be hydrated");
      applyDocumentSnapshot(
        { server_seq: 0, state_token: TOKEN, project },
        { scope: documentScope() },
      );
    });

    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("preserves the old Script mount for complete or unspecified hydration metadata", () => {
    join("comment", true);
    const complete = render(<ReviewHost guestShare />);
    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeVisible();
    complete.unmount();

    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("The guest project should be hydrated");
      useDawStore.setState({
        project: {
          ...project,
          meta: { name: "Test Episode", workspace_dir: "/tmp/test" },
        },
      });
    });
    render(<ReviewHost guestShare />);
    expect(
      screen.getByText("The host has not made a transcript of this version."),
    ).toBeVisible();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it("reschedules a deferred detail response when the document sequence moved", async () => {
    const first = deferred<{
      server_seq: number;
      state_token: string;
      project: ReturnType<typeof minimalProject>;
    }>();
    loadDetail
      .mockReturnValueOnce(first.promise)
      .mockImplementation(() => new Promise(() => undefined));
    join("comment", false);
    render(<ReviewHost guestShare />);

    noteDocumentSeq(1);
    await act(async () =>
      first.resolve({
        server_seq: 0,
        state_token: TOKEN,
        project: minimalProject({
          meta: {
            name: "Test Episode",
            workspace_dir: "/tmp/test",
            hydration: { transcript_words: true },
          },
        }),
      }),
    );

    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(
      useDawStore.getState().project?.meta.hydration?.transcript_words,
    ).toBe(false);
  });

  it("routes a detail token mismatch through shell recovery before retrying detail", async () => {
    const detail = deferred<{
      server_seq: number;
      state_token: string;
      project: ReturnType<typeof minimalProject>;
    }>();
    const refreshedToken = "d".repeat(64);
    const shell = minimalProject({
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: false },
      },
    });
    loadDetail
      .mockReturnValueOnce(detail.promise)
      .mockResolvedValueOnce({
        server_seq: 0,
        state_token: refreshedToken,
        project: shell,
      })
      .mockImplementation(() => new Promise(() => undefined));
    join("comment", false);
    render(<ReviewHost guestShare />);

    await act(async () =>
      detail.resolve({
        server_seq: 0,
        state_token: "e".repeat(64),
        project: minimalProject({
          meta: {
            name: "Test Episode",
            workspace_dir: "/tmp/test",
            hydration: { transcript_words: true },
          },
        }),
      }),
    );
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(3));

    expect(loadDetail.mock.calls.map(([, phase]) => phase)).toEqual([
      "detail",
      "shell",
      "detail",
    ]);
    expect(documentAuthority.token).toBe(refreshedToken);
    expect(transcriptDetailSnapshot()).toMatchObject({
      kind: "failed",
      recovering: true,
    });
    expect(
      useDawStore.getState().project?.meta.hydration?.transcript_words,
    ).toBe(false);
  });

  it("replaces a same-path request when a newer snapshot changes the sequence and token", () => {
    loadDetail.mockImplementation(() => new Promise(() => undefined));
    join("comment", false);
    const firstSignal = loadDetail.mock.calls[0]?.[2] as AbortSignal;
    const incomplete = useDawStore.getState().project;
    if (!incomplete) throw new Error("The guest project should be hydrated");

    act(() => {
      applyDocumentSnapshot(
        { server_seq: 1, state_token: "c".repeat(64), project: incomplete },
        { scope: documentScope() },
      );
    });

    expect(firstSignal.aborted).toBe(true);
    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(transcriptDetailSnapshot().kind).toBe("pending");
  });

  it("retires a pending request when a complete authoritative snapshot arrives", () => {
    join("comment", false);
    const signal = loadDetail.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    const complete = minimalProject({
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: true },
      },
    });

    act(() => {
      applyDocumentSnapshot(
        { server_seq: 1, state_token: TOKEN, project: complete },
        { scope: documentScope() },
      );
    });

    expect(signal.aborted).toBe(true);
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("turns an incomplete successful detail response into a retryable failure without looping", async () => {
    const response = deferred<{
      server_seq: number;
      state_token: string;
      project: ReturnType<typeof minimalProject>;
    }>();
    loadDetail.mockReturnValueOnce(response.promise);
    join("comment", false);
    render(<ReviewHost guestShare />);

    await act(async () =>
      response.resolve({
        server_seq: 0,
        state_token: TOKEN,
        project: minimalProject({
          meta: {
            name: "Test Episode",
            workspace_dir: "/tmp/test",
            hydration: { transcript_words: false },
          },
        }),
      }),
    );

    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(screen.getByText("The transcript didn't load")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(
      useDawStore.getState().project?.meta.hydration?.transcript_words,
    ).toBe(false);
  });

  it("ignores a deferred A reply after an A-to-B-to-A scope reset", async () => {
    const staleA = deferred<{
      server_seq: number;
      state_token: string;
      project: ReturnType<typeof minimalProject>;
    }>();
    loadDetail
      .mockReturnValueOnce(staleA.promise)
      .mockImplementation(() => new Promise(() => undefined));
    join("comment", false);
    const firstSignal = loadDetail.mock.calls[0]?.[2] as AbortSignal;

    const incomplete = minimalProject({
      meta: {
        name: "Test Episode",
        workspace_dir: "/tmp/test",
        hydration: { transcript_words: false },
      },
    });
    act(() => {
      useDawStore
        .getState()
        .hydrate(
          "share:other",
          incomplete,
          "comment",
          ["view", "comment", "suggest"],
          null,
          true,
        );
      scheduleTranscriptDetailHydrate(incomplete);
      useDawStore
        .getState()
        .hydrate(
          "share:tok",
          incomplete,
          "comment",
          ["view", "comment", "suggest"],
          null,
          true,
        );
      documentAuthority.token = TOKEN;
      documentAuthority.project = incomplete;
      documentAuthority.phase = { kind: "ready" };
      scheduleTranscriptDetailHydrate(incomplete);
    });

    expect(firstSignal.aborted).toBe(true);
    expect(loadDetail).toHaveBeenCalledTimes(3);
    await act(async () =>
      staleA.resolve({
        server_seq: 0,
        state_token: TOKEN,
        project: minimalProject({
          meta: {
            name: "Test Episode",
            workspace_dir: "/tmp/test",
            hydration: { transcript_words: true },
          },
        }),
      }),
    );
    expect(
      useDawStore.getState().project?.meta.hydration?.transcript_words,
    ).toBe(false);
    expect(transcriptDetailSnapshot().kind).toBe("pending");
  });
});
