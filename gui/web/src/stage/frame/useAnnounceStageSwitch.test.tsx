import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { StageFrameView } from "./StageFrameView";
import { useAnnounceStageSwitch } from "./useAnnounceStageSwitch";

function Harness() {
  const stage = useDawStore((s) => s.stage);
  useAnnounceStageSwitch(stage);
  return (
    <StageFrameView
      shell="desktop"
      stage={stage}
      stageLabel={stage}
      header={
        <button type="button" role="tab" aria-selected>
          Edit
        </button>
      }
    >
      <button type="button">inside</button>
    </StageFrameView>
  );
}

beforeEach(() => {
  useDawStore.setState({
    stage: "edit",
    statusAnnouncement: "",
    followingClientId: null,
  });
});

describe("useAnnounceStageSwitch", () => {
  it("says which stage opened and focuses its body when no tab has focus", () => {
    render(<Harness />);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    act(() => useDawStore.getState().openStage("review"));
    expect(useDawStore.getState().statusAnnouncement).toBe("Review stage");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("leaves a Stage tab's focus alone: the tab announces itself", () => {
    render(<Harness />);
    screen.getByRole("tab").focus();
    act(() => useDawStore.getState().openStage("deliver"));
    expect(screen.getByRole("tab")).toHaveFocus();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("stays quiet for a switch a Follow leader drove", () => {
    render(<Harness />);
    useDawStore.setState({ followingClientId: "leader" });
    act(() => useDawStore.getState().openStage("review"));
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    expect(screen.getByRole("main")).not.toHaveFocus();
  });
});
