import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSocialClip } from "../../api";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { SocialClipView } from "../../types/project";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  updateSocialClip: vi.fn(async () => undefined),
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

function open(hydrateAs: "host" | "share" = "host", id = "social-1") {
  const project = minimalProject({ social_clips: [clip] });
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
    expect(screen.getByText("A loaf tells you when it is ready")).toBeVisible();
    expect(screen.queryByText("0.87")).toBeNull();
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

  it("refuses an end that is not after the start", async () => {
    open();
    await typeScrub("End", "20");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "End must be greater than start",
    );
    expect(updateSocialClip).not.toHaveBeenCalled();
  });

  it("reports a failed save as an alert", async () => {
    vi.mocked(updateSocialClip).mockRejectedValueOnce(new Error("Save failed"));
    open();
    await typeScrub("End", "50");
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
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
    expect(updateSocialClip).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("says when the clip is gone", () => {
    open("host", "nope");
    expect(screen.getByText("Social clip not found")).toBeVisible();
  });
});
