import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addChapter } from "../api";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { OverlayLegend } from "./OverlayLegend";

vi.mock("../api", () => ({
  addChapter: vi.fn().mockResolvedValue(undefined),
}));

const addChapterMock = vi.mocked(addChapter);

describe("OverlayLegend", () => {
  beforeEach(() => {
    addChapterMock.mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("adds a chapter at the playhead time current when clicked, not when rendered", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({ playheadSec: 12 });
    });
    await userEvent.click(screen.getByRole("button", { name: "+ Chapter" }));
    expect(addChapterMock).toHaveBeenCalledWith(
      "/tmp/p.json",
      12,
      "Chapter 12.0s",
    );
  });
});
