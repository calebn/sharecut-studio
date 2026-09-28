import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { ProsodyOverlay, ProsodyOverlayTrack } from "../types/prosody";
import { ProsodyStatusAnnouncer } from "./ProsodyStatusAnnouncer";

function track(status: ProsodyOverlayTrack["status"]): ProsodyOverlayTrack {
  return {
    track_id: status,
    status,
    segments: [],
    boundaries: [],
    prominent_words: [],
    energy_db: null,
  };
}

describe("ProsodyStatusAnnouncer", () => {
  it("renders one status region with the summary text", async () => {
    const overlay: ProsodyOverlay = {
      schema: "prosody_overlay.v1",
      tracks: [track("missing"), track("missing")],
    };
    const { container } = render(<ProsodyStatusAnnouncer overlay={overlay} />);
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent("Prosody: no profile on 2 tracks");
    await expectNoA11yViolations(container);
  });

  it("renders one empty status region when there is no overlay", () => {
    render(<ProsodyStatusAnnouncer overlay={null} />);
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveTextContent("");
  });
});
