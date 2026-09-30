import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteChapter, updateChapter } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import { ChapterInspector } from "./ChapterInspector";

vi.mock("../../api", () => ({
  deleteChapter: vi.fn(async () => undefined),
  updateChapter: vi.fn(async () => undefined),
}));

describe("ChapterInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("names its editable fields and saves their values", async () => {
    const user = userEvent.setup();
    const { container } = render(<ChapterInspector title="Opening" time={5} />);
    const title = screen.getByRole("textbox", { name: "Chapter title" });
    const time = screen.getByRole("spinbutton", { name: "Chapter time" });
    expect(title).toHaveValue("Opening");
    expect(time).toHaveValue(5);
    await expectNoA11yViolations(container);
    await user.clear(title);
    await user.type(title, "Interview");
    await user.clear(time);
    await user.type(time, "12.5");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(updateChapter).toHaveBeenCalledWith(
      "/tmp/p.json",
      5,
      "Opening",
      12.5,
      "Interview",
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Interview",
      time: 12.5,
    });
  });

  it("retains typed values and reports a failed save", async () => {
    vi.mocked(updateChapter).mockRejectedValueOnce(new Error("Save failed"));
    const user = userEvent.setup();
    render(<ChapterInspector title="Opening" time={5} />);
    const title = screen.getByRole("textbox", { name: "Chapter title" });
    await user.clear(title);
    await user.type(title, "Interview");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(title).toHaveValue("Interview");
  });

  it("keeps chapter mutation unavailable on shares, including edit shares", async () => {
    useDawStore
      .getState()
      .hydrate("share:token", minimalProject(), "edit", ["edit"]);
    const { container } = render(<ChapterInspector title="Opening" time={5} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(updateChapter).not.toHaveBeenCalled();
    expect(deleteChapter).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });
});
