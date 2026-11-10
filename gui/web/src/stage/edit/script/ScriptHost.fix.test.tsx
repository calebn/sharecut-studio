import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import type { ScriptPaneHandle } from "../../../system/ScriptPane";
import { seedScript } from "../../../test/scriptHostKit";
import { StatusLive } from "../../frame/StatusLive";
import { ScriptHost } from "./ScriptHost";
import { useScriptFixText } from "./useScriptFixText";
import { useScriptModel } from "./useScriptModel";

const submitWordCorrection = vi.hoisted(() => vi.fn());
vi.mock("../../../transcript/wordCorrection", () => ({ submitWordCorrection }));
vi.mock("../../../commands/seek", () => ({ seekTransport: vi.fn() }));
const lastProps = vi.hoisted(() => ({
  current: null as null | import("../../../system/ScriptPane").ScriptPaneProps,
}));
vi.mock("../../../system/ScriptPane", async (original) => {
  const actual = await original<typeof import("../../../system/ScriptPane")>();
  const { forwardRef } = await import("react");
  return {
    ...actual,
    ScriptPane: forwardRef<
      import("../../../system/ScriptPane").ScriptPaneHandle,
      import("../../../system/ScriptPane").ScriptPaneProps
    >((props, ref) => {
      lastProps.current = props;
      return <actual.ScriptPane {...props} ref={ref} />;
    }),
  };
});

const word = (name: string) => screen.getByRole("button", { name });
const field = () => screen.getByRole("textbox", { name: /^Fix text/ });

function ScriptFixPaneBoundary({ wordVisible }: { wordVisible: boolean }) {
  const target = useRef<HTMLButtonElement>(null);
  const pane = useRef<ScriptPaneHandle | null>({
    scrollToWord: () => false,
    focusFind: () => false,
    focusWord: (index) => {
      if (index !== 5 || target.current === null) return false;
      target.current.focus();
      return target.current.ownerDocument.activeElement === target.current;
    },
  });
  const { model, texts } = useScriptModel();
  const fix = useScriptFixText(
    model,
    texts,
    pane,
    true,
    () => {},
    () => undefined,
  );
  return (
    <>
      <div className="sys-script-body">
        <button
          type="button"
          onClick={() => fix.onFixText?.({ start: 5, end: 5 }, "enter")}
        >
          Open correction
        </button>
        {fix.editing !== null ? (
          fix.renderEditor(fix.editing)
        ) : wordVisible ? (
          <button ref={target} type="button" data-stop="5">
            Returned word
          </button>
        ) : null}
      </div>
      <button type="button">External control</button>
    </>
  );
}

beforeEach(() => {
  submitWordCorrection.mockReset();
  submitWordCorrection.mockResolvedValue("h1");
  seedScript();
});

async function openWith(key: string) {
  render(<ScriptHost />);
  await userEvent.click(word("friends"));
  await userEvent.keyboard(key);
}

describe("ScriptHost Fix text", () => {
  it("returns keyboard focus when the word becomes available", async () => {
    const view = render(<ScriptFixPaneBoundary wordVisible={false} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Open correction" }),
    );
    const input = screen.getByRole("textbox", { name: "Fix text" });
    expect(input).toHaveValue("friends");
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    view.rerender(<ScriptFixPaneBoundary wordVisible />);
    expect(screen.getByRole("button", { name: "Returned word" })).toHaveFocus();
  });

  it("keeps an external destination when the word becomes available", async () => {
    const view = render(<ScriptFixPaneBoundary wordVisible={false} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Open correction" }),
    );
    expect(screen.getByRole("textbox", { name: "Fix text" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    const external = screen.getByRole("button", { name: "External control" });
    await userEvent.click(external);
    expect(external).toHaveFocus();
    view.rerender(<ScriptFixPaneBoundary wordVisible />);
    expect(external).toHaveFocus();
  });

  it("keeps the open field and its typing across a remount", async () => {
    const first = render(<ScriptHost />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.clear(field());
    await userEvent.type(field(), "frien");
    first.unmount();
    render(<ScriptHost />);
    expect(field()).toHaveValue("frien");
    await userEvent.type(field(), "d{Enter}");
    expect(submitWordCorrection).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      5,
      5,
      "friend",
      "friends",
      null,
    );
  });

  it.each([
    ["Enter", "{Enter}"],
    ["F2", "{F2}"],
  ])(
    "opens on %s and commits one word with the text it opened with",
    async (_n, key) => {
      await openWith(key);
      expect(field()).toHaveValue("friends");
      await userEvent.clear(field());
      await userEvent.type(field(), "friend{Enter}");
      expect(submitWordCorrection).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        5,
        5,
        "friend",
        "friends",
        null,
      );
      expect(screen.queryByRole("textbox")).toBeNull();
    },
  );

  it("does not open on a double-click, which only selects the word", async () => {
    render(<ScriptHost />);
    await userEvent.dblClick(word("show"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits a phrase on one track as one correction", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("back"));
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}{Enter}");
    expect(
      screen.getByRole("textbox", { name: "Fix text, 2 words" }),
    ).toHaveValue("back to");
    await userEvent.clear(field());
    await userEvent.type(field(), "come back to{Enter}");
    expect(submitWordCorrection).toHaveBeenCalledTimes(1);
    expect(submitWordCorrection).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      1,
      2,
      "come back to",
      "back to",
      null,
    );
  });

  it("refuses a span across speakers before the field opens", () => {
    render(<ScriptHost />);
    act(() => lastProps.current?.onFixText?.({ start: 5, end: 6 }, "enter"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /one speaker at a time/,
    );
    expect(submitWordCorrection).not.toHaveBeenCalled();
  });

  it("keeps the field open with the reason when the commit is refused", async () => {
    submitWordCorrection.mockRejectedValue(new Error("The words changed."));
    useDawStore.setState({ feedbackToast: null });
    await openWith("{Enter}");
    await userEvent.type(field(), "x{Enter}");
    expect(field()).toHaveValue("friendsx");
    expect(await screen.findByText("The words changed.")).toBeInTheDocument();
    expect(
      screen.getAllByRole("status").map((region) => region.textContent),
    ).toContain("Text not fixed. The words changed.");
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("reports a deferred correction failure once after ScriptHost unmounts", async () => {
    let rejectCorrection!: (failure: Error) => void;
    submitWordCorrection.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectCorrection = reject;
        }),
    );
    const view = render(
      <>
        <ScriptHost />
        <StatusLive />
      </>,
    );
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.clear(field());
    await userEvent.type(field(), "friend");
    useDawStore.setState({
      feedbackToast: null,
      statusAnnouncement: "",
      statusAnnouncementSeq: 40,
    });
    const initialAnnouncementSeq = useDawStore.getState().statusAnnouncementSeq;
    await userEvent.keyboard("{Enter}");
    expect(submitWordCorrection).toHaveBeenCalledTimes(1);
    expect(submitWordCorrection).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      5,
      5,
      "friend",
      "friends",
      null,
    );
    view.rerender(<StatusLive />);
    await act(async () => rejectCorrection(new Error("The words changed.")));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Could not fix “friends”: The words changed.",
      tone: "error",
    });
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Could not fix “friends”: The words changed.",
    );
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(
      initialAnnouncementSeq + 1,
    );
    const announcedSequence = useDawStore.getState().statusAnnouncementSeq;
    view.rerender(<StatusLive />);
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(
      announcedSequence,
    );
  });

  it("keeps a remounted draft when an earlier correction fails", async () => {
    let rejectCorrection!: (failure: Error) => void;
    submitWordCorrection.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectCorrection = reject;
        }),
    );
    const first = render(<ScriptHost />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.clear(field());
    await userEvent.type(field(), "friend{Enter}");
    first.unmount();

    render(
      <>
        <ScriptHost />
        <StatusLive />
      </>,
    );
    expect(field()).toHaveValue("friend");
    await userEvent.clear(field());
    await userEvent.type(field(), "new draft");
    await act(async () => rejectCorrection(new Error("The words changed.")));
    expect(field()).toHaveValue("new draft");
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Could not fix “friends”: The words changed.",
      tone: "error",
    });
  });

  it("reports a deferred correction failure once under StrictMode", async () => {
    let rejectCorrection!: (failure: Error) => void;
    submitWordCorrection.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectCorrection = reject;
        }),
    );
    const view = render(
      <StrictMode>
        <>
          <ScriptHost />
          <StatusLive />
        </>
      </StrictMode>,
    );
    useDawStore.setState({
      feedbackToast: null,
      statusAnnouncement: "",
      statusAnnouncementSeq: 70,
    });
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.type(field(), "friend{Enter}");
    view.rerender(<StatusLive />);
    const beforeFailure = useDawStore.getState().statusAnnouncementSeq;
    await act(async () => rejectCorrection(new Error("The words changed.")));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Could not fix “friends”: The words changed.",
      tone: "error",
    });
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(
      beforeFailure + 1,
    );
  });

  it("drops a deferred failure after switching away and back to its project", async () => {
    let rejectCorrection!: (failure: Error) => void;
    submitWordCorrection.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectCorrection = reject;
        }),
    );
    render(
      <>
        <ScriptHost />
        <StatusLive />
      </>,
    );
    useDawStore.setState({
      feedbackToast: null,
      statusAnnouncement: "",
      statusAnnouncementSeq: 90,
    });
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.type(field(), "friend{Enter}");
    const project = useDawStore.getState().project;
    if (!project) throw new Error("expected the seeded project");
    act(() => {
      useDawStore.getState().hydrate("/tmp/other", project);
      useDawStore.getState().hydrate("/tmp/ep", project);
    });
    const beforeFailure = useDawStore.getState().statusAnnouncementSeq;
    await act(async () => rejectCorrection(new Error("The words changed.")));
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(beforeFailure);
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });

  it("closes on Escape without a call and puts focus back on the word", async () => {
    await openWith("{F2}");
    await userEvent.keyboard("{Escape}");
    expect(submitWordCorrection).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(word("friends (selected)")).toHaveFocus();
    expect(useDawStore.getState().selection).not.toBeNull();
  });

  it("returns focus to the word after a saved fix", async () => {
    await openWith("{Enter}");
    await userEvent.type(field(), "!{Enter}");
    await act(async () => {});
    expect(word("friends (selected)")).toHaveFocus();
  });

  it("saves a blur commit once and keeps the external destination focused", async () => {
    let resolveCorrection!: (head: string) => void;
    submitWordCorrection.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveCorrection = resolve)),
    );
    render(
      <>
        <ScriptHost />
        <button type="button">Project destination</button>
      </>,
    );
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.clear(field());
    await userEvent.type(field(), "friend");
    await userEvent.click(
      screen.getByRole("button", { name: "Project destination" }),
    );
    expect(submitWordCorrection).toHaveBeenCalledTimes(1);
    expect(submitWordCorrection).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      5,
      5,
      "friend",
      "friends",
      null,
    );

    await act(async () => resolveCorrection("h1"));

    expect(
      screen.getByRole("button", { name: "Project destination" }),
    ).toHaveFocus();
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Text fixed: friend",
      undo: "h1",
    });
    expect(submitWordCorrection).toHaveBeenCalledTimes(1);
  });

  it("retires an unchanged blur without submitting or stealing focus", async () => {
    render(
      <>
        <ScriptHost />
        <button type="button">Project destination</button>
      </>,
    );
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.click(
      screen.getByRole("button", { name: "Project destination" }),
    );

    expect(submitWordCorrection).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Project destination" }),
    ).toHaveFocus();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Tab", "{Tab}"],
  ])(
    "keeps an external destination after a deferred %s correction",
    async (_name, key) => {
      let resolveCorrection!: (head: string) => void;
      submitWordCorrection.mockImplementationOnce(
        () => new Promise<string>((resolve) => (resolveCorrection = resolve)),
      );
      render(
        <>
          <ScriptHost />
          <button type="button">External destination</button>
        </>,
      );
      await userEvent.click(word("friends"));
      await userEvent.keyboard("{Enter}");
      await userEvent.clear(field());
      await userEvent.type(field(), "friend");
      await userEvent.keyboard(key);
      const selectionBeforeCompletion = useDawStore.getState().selection;
      await userEvent.click(
        screen.getByRole("button", { name: "External destination" }),
      );

      await act(async () => resolveCorrection("h1"));

      expect(
        screen.getByRole("button", { name: "External destination" }),
      ).toHaveFocus();
      expect(submitWordCorrection).toHaveBeenCalledTimes(1);
      expect(submitWordCorrection).toHaveBeenCalledWith(
        "/tmp/ep",
        "host",
        5,
        5,
        "friend",
        "friends",
        null,
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        undo: "h1",
      });
      if (key === "{Tab}") {
        expect(useDawStore.getState().selection).toEqual(
          selectionBeforeCompletion,
        );
      }
    },
  );

  it("jumps to the next unsure word on Tab after saving", async () => {
    await openWith("{Enter}");
    await userEvent.type(field(), "!{Tab}");
    await act(async () => {});
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 2,
    });
    expect(word("to (unsure, selected)")).toHaveFocus();
  });

  it("announces the fix as a toast with Undo for its history step", async () => {
    await openWith("{Enter}");
    await userEvent.type(field(), "!{Enter}");
    await act(async () => {});
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Text fixed: friends!",
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Text fixed: friends!",
      undo: "h1",
    });
  });

  it("is not offered to a share guest, even an editor", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "edit",
      shareCapabilities: ["play", "view", "comment", "edit"],
    });
    render(<ScriptHost />);
    await userEvent.dblClick(word("show"));
    fireEvent.keyDown(word("show (selected)"), { key: "F2" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("is not offered while the words are still loading", () => {
    seedScript({
      project: {
        meta: {
          name: "x",
          workspace_dir: "/t",
          hydration: { transcript_words: false },
        } as never,
      },
    });
    render(<ScriptHost />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
