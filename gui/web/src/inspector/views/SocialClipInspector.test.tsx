import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSocialClip, updateSocialClip } from "../../api";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { SocialClipView } from "../../types/project";
import { SocialClipInspector } from "./SocialClipInspector";

vi.mock("../../api", () => ({
  deleteSocialClip: vi.fn(async () => undefined),
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

describe("SocialClipInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names its editable fields on a project the host owns", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<SocialClipInspector clip={clip} onSeek={vi.fn()} />);
    expect(
      screen.getByRole("spinbutton", { name: "Social clip start" }),
    ).toHaveValue(28);
    expect(
      screen.getByRole("spinbutton", { name: "Social clip end" }),
    ).toHaveValue(44);
    expect(screen.getByRole("button", { name: "Apply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  it("shows the range as text and offers no mutation on a share", async () => {
    useDawStore
      .getState()
      .hydrate(shareProjectKey("tok"), minimalProject(), "edit", ["edit"]);
    const { container } = render(
      <SocialClipInspector clip={clip} onSeek={vi.fn()} />,
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText(/00:28\.000 – 00:44\.000/)).toBeVisible();
    expect(updateSocialClip).not.toHaveBeenCalled();
    expect(deleteSocialClip).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });
});
