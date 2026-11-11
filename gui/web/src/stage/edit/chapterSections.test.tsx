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
    expect(title).toHaveValue("Opening");
  });

  it("shows the stored title after a trailing space saves nothing", async () => {
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.type(title, " {Enter}");
    expect(title).toHaveValue("Opening");
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

  it("keeps the Inspector open on the renamed chapter", async () => {
    const user = userEvent.setup();
    open();
    useDawStore.setState({ inspectorKey: "chapter:Opening" });
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview{Enter}");
    expect(updateChapter).toHaveBeenCalledExactlyOnceWith(
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
    expect(useDawStore.getState().inspectorKey).toBe("chapter:Interview");
  });

  it("leaves a newer selection alone when a slow rename finishes", async () => {
    let finish: () => void = () => undefined;
    vi.mocked(updateChapter).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview{Enter}");
    act(() => useDawStore.setState({ selection: { kind: "social", id: "x" } }));
    await act(async () => finish());
    expect(useDawStore.getState().selection).toEqual({
      kind: "social",
      id: "x",
    });
  });

  it("puts the title back on Escape and lets a second Escape through", async () => {
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview");
    await user.keyboard("{Escape}");
    expect(title).toHaveValue("Opening");
    expect(updateChapter).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(title, { key: "Escape" })).toBe(true);
  });

  it("holds the title read-only while a save is in flight", async () => {
    let settle: () => void = () => undefined;
    vi.mocked(updateChapter).mockImplementationOnce(
      () =>
        new Promise<undefined>(
          (resolve) => (settle = () => resolve(undefined)),
        ),
    );
    const user = userEvent.setup();
    open();
    await typeScrub("Time", "6");
    const title = screen.getByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("readonly");
    expect(title).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("spinbutton", { name: "Time" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await user.type(title, "X");
    expect(title).toHaveValue("Opening");
    await act(async () => settle());
    expect(title).not.toHaveAttribute("readonly");
    await user.type(title, "!");
    expect(title).toHaveValue("Opening!");
  });

  it("refuses a time outside the episode", async () => {
    open();
    await typeScrub("Time", "4000");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a number from 0 to 60 s",
    );
    expect(updateChapter).not.toHaveBeenCalled();
  });

  it("saves a time inside the episode", async () => {
    open();
    await typeScrub("Time", "12");
    expect(updateChapter).toHaveBeenCalledExactlyOnceWith(
      "/tmp/p.json",
      5,
      "Opening",
      12,
      "Opening",
    );
  });

  it("offers neither Apply nor Seek", () => {
    open();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Seek" })).toBeNull();
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

  it("sends one save for two Enters while the first is pending", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    vi.mocked(updateChapter).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview");
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(updateChapter).toHaveBeenCalledTimes(1);
    await act(async () => settle());
  });

  it("sends nothing on blur while a save is pending", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    vi.mocked(updateChapter).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Time" }), {
        key: "ArrowUp",
      });
    });
    await user.tab();
    expect(updateChapter).toHaveBeenCalledTimes(1);
    await act(async () => settle());
  });

  it("commits a title draft held during a Time save after it settles", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    vi.mocked(updateChapter).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Interview");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Time" }), {
        key: "ArrowUp",
      });
    });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(updateChapter).toHaveBeenCalledTimes(1);
    await act(async () => settle());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Title" }), {
      key: "Enter",
    });
    expect(updateChapter).toHaveBeenCalledTimes(2);
    expect(updateChapter).toHaveBeenLastCalledWith(
      "/tmp/p.json",
      5.01,
      "Opening",
      5.01,
      "Interview",
    );
  });
});
