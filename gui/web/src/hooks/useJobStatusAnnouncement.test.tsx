import { render } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { useJobStatusAnnouncement } from "./useJobStatusAnnouncement";

function Probe() {
  useJobStatusAnnouncement();
  return null;
}

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  useDawStore.setState({ pipelineJob: null, statusAnnouncement: "" });
});

it("speaks a failed job's message without its internals", () => {
  render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <Probe />
    </DawProvider>,
  );
  useDawStore.setState({
    pipelineJob: {
      id: "j1",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "export",
      status: "error",
      message: "Set PODCAST_MCP_FFMPEG to its bin executable.",
    } as never,
  });
  return Promise.resolve().then(() => {
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/PODCAST/);
    expect(useDawStore.getState().statusAnnouncement).toMatch(/Export/);
  });
});

it("speaks a missing model plainly, not the command its raw text carries", () => {
  render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <Probe />
    </DawProvider>,
  );
  useDawStore.setState({
    pipelineJob: {
      id: "j2",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "pipeline",
      status: "error",
      message:
        "needs Noise reduction (RNNoise) (~0.3 MB); run `podcast bootstrap --component rnnoise`",
      error_code: "model_needed",
      error_model: {
        id: "rnnoise",
        model: "rnnoise",
        label: "Noise reduction (RNNoise)",
        purpose: "noise reduction",
        size: "~0.3 MB",
        size_bytes: 297646,
        state: "missing",
      },
    } as never,
  });
  return Promise.resolve().then(() => {
    const spoken = useDawStore.getState().statusAnnouncement;
    expect(spoken).toContain("Noise reduction (RNNoise) is not downloaded.");
    expect(spoken).not.toMatch(/bootstrap|needs Noise/);
  });
});
