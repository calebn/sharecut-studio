import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSocialClip, updateSocialClipDetails } from "../../api";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { SocialClipView } from "../../types/project";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  updateSocialClip: vi.fn(async () => undefined),
  updateSocialClipDetails: vi.fn(async () => undefined),
}));

const clip: SocialClipView = {
  id: "social-1",
  track_id: "host",
  start: 28,
  end: 44,
  score: 0.87,
  title_suggestion: "A loaf tells you when it is ready",
  approved: false,
  review_required: true,
};

function open(
  hydrateAs: "host" | "share" = "host",
  id = "social-1",
  view: SocialClipView = clip,
  duration = 60,
) {
  const project = minimalProject({
    social_clips: [view],
    timeline_duration_sec: duration,
  });
  if (hydrateAs === "share")
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), project, "edit", ["edit"]);
  else useDawStore.getState().hydrate("/tmp/p.json", project);
  useDawStore.setState({ selection: { kind: "social", id } });
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

describe("social clip content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names its fields on a project the host owns", async () => {
    const { container } = open();
    expect(screen.getByRole("spinbutton", { name: "Start" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "End" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "A loaf tells you when it is ready",
    );
    expect(screen.getByRole("img", { name: "Quality 4 of 5" })).toBeVisible();
    expect(screen.queryByText("0.87")).toBeNull();
    expect(screen.queryByText("host")).toBeNull();
    expect(screen.queryByText("Score")).toBeNull();
    expect(screen.queryByText("Approved")).toBeNull();
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByRole("button", { name: "Seek to start" })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("saves the start once with the end unchanged", async () => {
    open();
    await typeScrub("Start", "30");
    expect(updateSocialClip).toHaveBeenCalledTimes(1);
    expect(updateSocialClip).toHaveBeenCalledWith(
      "/tmp/p.json",
      "social-1",
      30,
      44,
    );
  });

  it("saves the end once with the start unchanged", async () => {
    open();
    await typeScrub("End", "50");
    expect(updateSocialClip).toHaveBeenCalledTimes(1);
    expect(updateSocialClip).toHaveBeenCalledWith(
      "/tmp/p.json",
      "social-1",
      28,
      50,
    );
  });

  it.each([
    { name: "Start", key: "ArrowDown", next: [17.99, 18.05] },
    { name: "End", key: "ArrowUp", next: [18, 18.06] },
  ])(
    "widens a saved short clip by a single $name step",
    async ({ name, key, next }) => {
      open("host", clip.id, { ...clip, start: 18, end: 18.05 });
      const field = () => screen.getByRole("spinbutton", { name });
      fireEvent.keyDown(field(), { key: "Enter" });
      fireEvent.blur(screen.getByRole("textbox", { name }));
      expect(updateSocialClip).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.keyDown(field(), { key });
      });
      expect(updateSocialClip).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        clip.id,
        ...next,
      );
    },
  );

  it.each([
    { name: "Start", inward: "ArrowUp" },
    { name: "End", inward: "ArrowDown" },
  ])(
    "keeps an exact $name when nudged inward on a short clip",
    async ({ name, inward }) => {
      open("host", clip.id, { ...clip, start: 18.008, end: 18.052 });
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("spinbutton", { name }), {
          key: inward,
        });
      });
      expect(updateSocialClip).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "Start", inward: "ArrowUp" },
    { name: "End", inward: "ArrowDown" },
  ])(
    "keeps an exact $name at the blocked end of an Alt nudge",
    async ({ name, inward }) => {
      open("host", clip.id, { ...clip, start: 18.002, end: 18.058 });
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("spinbutton", { name }), {
          key: inward,
          altKey: true,
        });
      });
      expect(updateSocialClip).not.toHaveBeenCalled();
    },
  );

  it("does not save a Start drag that returns to the saved fractional boundary", async () => {
    open("host", clip.id, { ...clip, start: 18.008, end: 18.052 });
    const field = screen.getByRole("spinbutton", { name: "Start" });
    fireEvent.pointerDown(field, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(field, { clientX: 90, pointerId: 1 });
    fireEvent.pointerMove(field, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(field, { clientX: 90, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(field, { pointerId: 1 });
    });
    expect(updateSocialClip).not.toHaveBeenCalled();
  });

  it.each(["Start", "End"])(
    "closes an untouched exact %s editor without saving",
    async (name) => {
      open("host", clip.id, { ...clip, start: 18.008, end: 18.052 });
      const user = userEvent.setup();
      screen.getByRole("spinbutton", { name }).focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("textbox", { name })).not.toHaveAttribute(
        "aria-invalid",
        "true",
      );
      await user.keyboard("{Enter}");
      expect(screen.getByRole("spinbutton", { name })).toHaveFocus();
      expect(updateSocialClip).not.toHaveBeenCalled();
    },
  );

  it("does not shorten an already widened short clip", async () => {
    open("host", clip.id, { ...clip, start: 17.99, end: 18.05 });
    await typeScrub("Start", "18");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a number from 0 to 17.99 s",
    );
    expect(updateSocialClip).not.toHaveBeenCalled();
  });

  it("keeps a short clip at a fractional episode end when End cannot move", async () => {
    const episodeEnd = 18.055;
    open("host", clip.id, { ...clip, start: 18, end: episodeEnd }, episodeEnd);
    const end = screen.getByRole("spinbutton", { name: "End" });
    expect(end).toHaveAttribute("aria-valuenow", String(episodeEnd));
    await act(async () => {
      fireEvent.keyDown(end, { key: "ArrowUp" });
    });
    expect(updateSocialClip).not.toHaveBeenCalled();
    expect(end).toHaveAttribute("aria-valuemax", String(episodeEnd));
  });

  it("stops an outward End nudge at the exact episode boundary", async () => {
    open("host", clip.id, { ...clip, start: 18, end: 18.055 }, 18.064);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("spinbutton", { name: "End" }), {
        key: "ArrowUp",
      });
    });
    expect(updateSocialClip).toHaveBeenCalledExactlyOnceWith(
      "/tmp/p.json",
      clip.id,
      18,
      18.064,
    );
  });

  it.each([
    { start: 18.004, end: 18.098, duration: 18.105 },
    { start: 18, end: 18.095, duration: 18.1 },
  ])(
    "keeps End at the episode ceiling $duration after the clip reaches 0.1 s",
    async ({ start, end, duration }) => {
      open("host", clip.id, { ...clip, start, end }, duration);
      const nudgeEnd = () =>
        act(async () => {
          fireEvent.keyDown(screen.getByRole("spinbutton", { name: "End" }), {
            key: "ArrowUp",
          });
        });
      await nudgeEnd();
      expect(updateSocialClip).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        clip.id,
        start,
        duration,
      );
      act(() => {
        const saved = { ...clip, start, end: duration };
        const project = useDawStore.getState().project!;
        useDawStore.setState({
          project: { ...project, social_clips: [saved] },
        });
      });
      await nudgeEnd();
      expect(updateSocialClip).toHaveBeenCalledTimes(1);
    },
  );

  it("moves Start in the requested direction to the exact 0.1 s limit after End widens", async () => {
    const start = 18.008;
    const duration = 18.109;
    open("host", clip.id, { ...clip, start, end: 18.052 }, duration);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("spinbutton", { name: "End" }), {
        key: "ArrowUp",
        shiftKey: true,
      });
    });
    expect(updateSocialClip).toHaveBeenCalledExactlyOnceWith(
      "/tmp/p.json",
      clip.id,
      start,
      duration,
    );
    act(() => {
      const saved = { ...clip, start, end: duration };
      const project = useDawStore.getState().project!;
      useDawStore.setState({ project: { ...project, social_clips: [saved] } });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Start" }), {
        key: "ArrowUp",
      });
    });
    expect(updateSocialClip).toHaveBeenCalledTimes(2);
    expect(updateSocialClip).toHaveBeenLastCalledWith(
      "/tmp/p.json",
      clip.id,
      expect.closeTo(18.009, 10),
      duration,
    );
  });

  it("refuses an end before the minimum span with the range", async () => {
    open();
    await typeScrub("End", "20");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a number from 28.1 to 60 s",
    );
    expect(updateSocialClip).not.toHaveBeenCalled();
  });

  it("refuses a start at or after the end with the range", async () => {
    open();
    await typeScrub("Start", "44");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a number from 0 to 43.9 s",
    );
    expect(updateSocialClip).not.toHaveBeenCalled();
  });

  it("retitles through the details command and leaves the range alone", async () => {
    const user = userEvent.setup();
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Bread{Enter}");
    expect(updateSocialClipDetails).toHaveBeenCalledTimes(1);
    expect(updateSocialClipDetails).toHaveBeenCalledWith(
      "/tmp/p.json",
      "social-1",
      { title: "Bread" },
    );
    expect(updateSocialClip).not.toHaveBeenCalled();
  });

  it("clears the title when it is emptied", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(screen.getByRole("textbox", { name: "Title" }));
    await user.keyboard("{Enter}");
    expect(updateSocialClipDetails).toHaveBeenCalledTimes(1);
    expect(updateSocialClipDetails).toHaveBeenCalledWith(
      "/tmp/p.json",
      "social-1",
      { title: "" },
    );
  });

  it("reports a refused retitle as an alert", async () => {
    const user = userEvent.setup();
    vi.mocked(updateSocialClipDetails).mockRejectedValueOnce(
      new Error("Save failed"),
    );
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Bread{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  });

  it("shows no Quality for a clip added by hand and invites a title", () => {
    open("host", "manual", {
      ...clip,
      id: "manual",
      score: 0,
      title_suggestion: null,
    });
    expect(screen.queryByRole("img", { name: /Quality/ })).toBeNull();
    const title = screen.getByRole("textbox", { name: "Title" });
    expect(title).toHaveValue("");
    expect(title).toHaveAttribute("placeholder", "Untitled clip");
    expect(screen.getByRole("spinbutton", { name: "Start" })).toBeVisible();
  });

  it("reports a failed save as an alert", async () => {
    vi.mocked(updateSocialClip).mockRejectedValueOnce(new Error("Save failed"));
    open();
    await typeScrub("End", "50");
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  });

  it("holds the title read-only while a save is in flight", async () => {
    let settle: () => void = () => undefined;
    vi.mocked(updateSocialClip).mockImplementationOnce(
      () =>
        new Promise<undefined>(
          (resolve) => (settle = () => resolve(undefined)),
        ),
    );
    const user = userEvent.setup();
    open();
    await typeScrub("Start", "30");
    const title = screen.getByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("readonly");
    expect(title).toHaveAttribute("aria-busy", "true");
    for (const name of ["Start", "End"])
      expect(screen.getByRole("spinbutton", { name })).toHaveAttribute(
        "aria-busy",
        "true",
      );
    await user.type(title, "X");
    expect(title).toHaveValue("A loaf tells you when it is ready");
    await act(async () => settle());
    expect(title).not.toHaveAttribute("readonly");
    await user.type(title, "!");
    expect(title).toHaveValue("A loaf tells you when it is ready!");
  });

  it("shows the range read-only and offers no mutation on a share", async () => {
    const { container } = open("share");
    expect(screen.getByRole("spinbutton", { name: "Start" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.getByRole("spinbutton", { name: "End" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(screen.getByText("A loaf tells you when it is ready")).toBeVisible();
    expect(updateSocialClip).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("says when the clip is gone", () => {
    open("host", "nope");
    expect(screen.getByText("Social clip not found")).toBeVisible();
  });

  it("sends one retitle for two Enters while the first is pending", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    vi.mocked(updateSocialClipDetails).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Bread");
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(updateSocialClipDetails).toHaveBeenCalledTimes(1);
    await act(async () => settle());
  });

  it("sends nothing on blur while a save is pending", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    vi.mocked(updateSocialClipDetails).mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          settle = () => resolve(undefined);
        }),
    );
    open();
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Bread");
    fireEvent.keyDown(title, { key: "Enter" });
    await user.tab();
    expect(updateSocialClipDetails).toHaveBeenCalledTimes(1);
    await act(async () => settle());
  });
});
