import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { OverlayLegend } from "./OverlayLegend";

describe("OverlayLegend", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("shows Prosody for a host project", () => {
    render(<OverlayLegend />);
    expect(screen.getByLabelText("Prosody")).toBeTruthy();
  });

  it("hides Prosody for a share key", () => {
    useDawStore.getState().hydrate(shareProjectKey("tok"), minimalProject());
    render(<OverlayLegend />);
    expect(screen.queryByLabelText("Prosody")).toBeNull();
  });
});
