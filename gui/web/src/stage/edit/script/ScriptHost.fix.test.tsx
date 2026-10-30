import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { seedScript } from "../../../test/scriptHostKit";
import { ScriptHost } from "./ScriptHost";

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

  it("opens on a double-click", async () => {
    render(<ScriptHost />);
    await userEvent.dblClick(word("show"));
    expect(field()).toHaveValue("show");
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
    await openWith("{Enter}");
    await userEvent.type(field(), "x{Enter}");
    expect(field()).toHaveValue("friendsx");
    expect(await screen.findByText("The words changed.")).toBeInTheDocument();
    expect(
      screen.getAllByRole("status").map((region) => region.textContent),
    ).toContain("Text not fixed. The words changed.");
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
    expect(await screen.findByText("Text fixed: friends!")).toBeInTheDocument();
    expect(word("friends (selected)")).toHaveFocus();
  });

  it("jumps to the next unsure word on Tab after saving", async () => {
    await openWith("{Enter}");
    await userEvent.type(field(), "!{Tab}");
    await act(async () => {});
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 2,
    });
  });

  it("announces the outcome in its own polite region", async () => {
    await openWith("{Enter}");
    await userEvent.type(field(), "!{Enter}");
    const regions = screen
      .getAllByRole("status")
      .map((region) => region.textContent);
    expect(regions).toContain("Text fixed: friends!");
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
