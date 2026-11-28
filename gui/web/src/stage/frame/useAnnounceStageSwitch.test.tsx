import { act, render, screen } from "@testing-library/react";
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

const userSwitch = (stage: "review" | "deliver", source?: "tab") =>
  act(() => {
    markUserStageSwitch(source);
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

  it("leaves a focused tab alone when that tab activates", () => {
    render(<Harness />);
    screen.getByRole("tab").focus();
    userSwitch("deliver", "tab");
    expect(screen.getByRole("tab")).toHaveFocus();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("keeps a tab activation quiet even in a browser that leaves focus elsewhere", () => {
    render(<Harness />);
    userSwitch("review", "tab");
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    expect(screen.getByRole("main")).not.toHaveFocus();
  });

  it("announces a stage command even when a Stage tab had focus", () => {
    render(<Harness />);
    screen.getByRole("tab").focus();
    userSwitch("review");
    expect(useDawStore.getState().statusAnnouncement).toBe("Review stage");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("announces but keeps focus in a field", () => {
    render(<Harness />);
    screen.getByRole("textbox", { name: "Name" }).focus();
    userSwitch("review");
    expect(useDawStore.getState().statusAnnouncement).toBe("Review stage");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });
});
