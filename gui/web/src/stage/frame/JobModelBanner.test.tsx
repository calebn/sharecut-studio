import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { minimalProject } from "../../test/fixtures";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { JobModelBanner } from "./JobModelBanner";

function failedJob(overrides: Partial<PipelineJobSnapshot>) {
  return {
    id: "job-1",
    kind: "render_preview",
    status: "error",
    error: "raw",
    error_code: "model_needed",
    error_model: {
      id: "rnnoise",
      label: "Noise reduction (RNNoise)",
      size: "1 MB",
      state: "missing",
    },
    ...overrides,
  } as unknown as PipelineJobSnapshot;
}

function mount(guestShare = false) {
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <JobModelBanner guestShare={guestShare} />
    </DawProvider>,
  );
}

describe("JobModelBanner", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("names the missing model when the latest job failed for it", () => {
    mount();
    act(() => {
      useDawStore.setState({ activityJob: failedJob({}) });
    });
    expect(
      screen.getByText(/Noise reduction \(RNNoise\) is not downloaded/),
    ).toBeTruthy();
  });

  it("stays out of the way for other failures and for guests", () => {
    const { container } = mount();
    act(() => {
      useDawStore.setState({
        activityJob: failedJob({ error_code: "other", error_model: null }),
      });
    });
    expect(container.textContent).toBe("");
    const guest = mount(true);
    act(() => {
      useDawStore.setState({ activityJob: failedJob({}) });
    });
    expect(guest.container.textContent).toBe("");
  });
});
