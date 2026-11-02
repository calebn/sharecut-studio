import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { markUserStageSwitch } from "../../commands/userStageSwitch";
import { withProgrammaticUi } from "../../presence/followSync";
import { useDawStore } from "../../state/dawStore";
import { StageFrameView } from "./StageFrameView";
import { useAnnounceStageSwitch } from "./useAnnounceStageSwitch";

function Harness() {
  const stage = useDawStore((s) => s.stage);
  useAnnounceStageSwitch(stage);
  return (
    <>
      <input aria-label="Name" />
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
    </>
  );
}

const userSwitch = (stage: "review" | "deliver") =>
  act(() => {
    markUserStageSwitch();
    useDawStore.getState().openStage(stage);
  });

beforeEach(() => {
  useDawStore.setState({
    stage: "edit",
    statusAnnouncement: "",
    followingClientId: null,
  });
});

describe("useAnnounceStageSwitch", () => {
  it("says which stage opened and focuses its body after a stage command", () => {
    render(<Harness />);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    userSwitch("review");
    expect(useDawStore.getState().statusAnnouncement).toBe("Review stage");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("is quiet for a switch no stage command made, such as the landing", () => {
    render(<Harness />);
    act(() => useDawStore.getState().openStage("review"));
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    expect(screen.getByRole("main")).not.toHaveFocus();
  });

  it("is quiet for a switch a Follow leader drove", () => {
    render(<Harness />);
    act(() =>
      withProgrammaticUi(() => {
        markUserStageSwitch();
        useDawStore.getState().openStage("review");
      }),
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("leaves a focused Stage tab alone: the tab announces itself", () => {
    render(<Harness />);
    screen.getByRole("tab").focus();
    userSwitch("deliver");
    expect(screen.getByRole("tab")).toHaveFocus();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("treats a mouse press on a tab as a tab switch where the browser does not focus it", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByRole("tab"));
    screen.getByRole("tab").blur();
    userSwitch("review");
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("announces but keeps focus in a field", () => {
    render(<Harness />);
    screen.getByRole("textbox", { name: "Name" }).focus();
    userSwitch("review");
    expect(useDawStore.getState().statusAnnouncement).toBe("Review stage");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });
});
