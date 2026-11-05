import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateChapter } from "../../api";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  updateChapter: vi.fn(async () => undefined),
}));

function open(hydrateAs: "host" | "share" = "host") {
  if (hydrateAs === "share")
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), minimalProject(), "edit", ["edit"]);
  else useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  useDawStore.setState({
    selection: { kind: "chapter", id: "Opening", time: 5 },
  });
  return render(<SectionsBody withRange={false} />);
}

async function typeScrub(name: string, value: string) {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("spinbutton", { name }), {
      key: "Enter",
    });
  });
  const input = screen.getByRole("textbox", { name });
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

describe("chapter content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names its fields and saves a retitle once on blur", async () => {
    const user = userEvent.setup();
    const { container } = open();
    const title = screen.getByRole("textbox", { name: "Title" });
    expect(title).toHaveValue("Opening");
    expect(screen.getByRole("spinbutton", { name: "Time" })).toBeVisible();
    await expectNoA11yViolations(container);
    await user.clear(title);
    await user.type(title, "Interview");
    expect(updateChapter).not.toHaveBeenCalled();
    await user.tab();
    expect(updateChapter).toHaveBeenCalledTimes(1);
    expect(updateChapter).toHaveBeenCalledWith(
      "/tmp/p.json",
      5,
      "Opening",
      5,
      "Interview",
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Interview",
      time: 5,
    });
  });

  it("keeps the focused draft for the same chapter and resets it for a new chapter", async () => {
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Unsubmitted");
    act(() => {
      useDawStore.setState({
        selection: { kind: "chapter", id: "Opening", time: 5 },
      });
    });
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
    expect(title).toHaveFocus();
    expect(title).toHaveValue("Unsubmitted");
    act(() => {
      useDawStore.setState({
        selection: { kind: "chapter", id: "Interview", time: 20 },
      });
    });
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
    expect(title).toHaveFocus();
    expect(title).toHaveValue("Interview");
    expect(updateChapter).not.toHaveBeenCalled();
  });

  it("saves a retitle on Enter", async () => {
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview{Enter}");
    expect(updateChapter).toHaveBeenCalledTimes(1);
  });

  it("does not save an unchanged title", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("textbox", { name: "Title" }));
    await user.tab();
    expect(updateChapter).not.toHaveBeenCalled();
  });

  it("refuses an empty title and restores nothing to the server", async () => {
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Title cannot be empty",
    );
    expect(updateChapter).not.toHaveBeenCalled();
  });

  it("saves a new time through the Scrub field with the old identity", async () => {
    open();
    await typeScrub("Time", "12.5");
    expect(updateChapter).toHaveBeenCalledTimes(1);
    expect(updateChapter).toHaveBeenCalledWith(
      "/tmp/p.json",
      5,
      "Opening",
      12.5,
      "Opening",
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Opening",
      time: 12.5,
    });
  });

  it("keeps the typed title and reports a failed save as an alert", async () => {
    vi.mocked(updateChapter).mockRejectedValueOnce(new Error("Save failed"));
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview");
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(title).toHaveValue("Interview");
  });

  it("keeps chapter mutation unavailable on shares, including edit shares", async () => {
    const { container } = open("share");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Opening")).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Time" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(updateChapter).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });
});
