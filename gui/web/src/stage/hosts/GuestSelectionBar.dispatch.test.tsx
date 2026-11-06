import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRangeAction } from "../../commands/rangeActions";
import { useDawStore } from "../../state/dawStore";
import { COMMENTER_CAPABILITIES } from "../../test/fixtures";
import { GuestSelectionBar } from "./GuestSelectionBar";

vi.mock("../../commands/rangeActions", () => ({
  runRangeAction: vi.fn(async () => ({ status: "done" })),
}));

describe("GuestSelectionBar verbs", () => {
  beforeEach(() => {
    vi.mocked(runRangeAction).mockClear();
    useDawStore.setState({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
    });
  });

  it("sends Comment as 'comment' and Suggest a cut as 'cut'", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<button class="sys-script-word" data-word-key="0:host::0"></button>`;
    document.body.append(root);
    act(() =>
      useDawStore.getState().setSelection({
        kind: "transcriptRange",
        trackId: "host",
        sourceId: null,
        startWordIndex: 0,
        endWordIndex: 0,
      }),
    );
    render(<GuestSelectionBar root={root} />);
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(runRangeAction).toHaveBeenLastCalledWith("comment");
    await userEvent.click(
      screen.getByRole("button", { name: "Suggest a cut" }),
    );
    expect(runRangeAction).toHaveBeenLastCalledWith("cut");
    expect(runRangeAction).toHaveBeenCalledTimes(2);
    root.remove();
  });
});
