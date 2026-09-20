import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetExportDeliverablesInFlightForTests,
  registerDawCommands,
} from "./register";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    startExportJob: vi.fn(),
    followExportJob: vi.fn(),
  };
});

vi.mock("../state/seedStudioJob", () => ({
  seedStudioJob: vi.fn(),
}));

const startMock = vi.mocked(api.startExportJob);
const followMock = vi.mocked(api.followExportJob);

function jobSnapshot(id: string): PipelineJobSnapshot {
  return {
    id,
    project_path: "/tmp/test/episode.project.json",
    from_step: null,
    only_step: null,
    kind: "export",
    status: "running",
  } as PipelineJobSnapshot;
}

describe("export.deliverables", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    _resetExportDeliverablesInFlightForTests();
    registerDawCommands();
    startMock.mockReset();
    followMock.mockReset();
    useDawStore.setState({
      projectPath: "/tmp/test/episode.project.json",
      project: minimalProject(),
      guestMode: null,
      statusAnnouncement: "",
    });
  });

  afterEach(() => {
    _resetExportDeliverablesInFlightForTests();
  });

  it("rejects a second invocation while the first export is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startMock.mockImplementation(() => gate.then(() => jobSnapshot("job-1")));
    followMock.mockResolvedValue(["export/a.wav"]);

    const first = execute("export.deliverables");
    const second = execute("export.deliverables");

    const secondResult = await second;
    expect(secondResult.status).toBe("disabled");
    if (secondResult.status === "disabled") {
      expect(secondResult.reason).toBe("Export already running");
    } else {
      expect.unreachable("expected disabled result");
    }
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Export already in progress…",
    );

    release();
    expect((await first).status).toBe("ok");
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("allows a new export after the previous one finishes", async () => {
    startMock.mockResolvedValue(jobSnapshot("job-1"));
    followMock.mockResolvedValue(["export/a.wav"]);

    expect((await execute("export.deliverables")).status).toBe("ok");
    expect((await execute("export.deliverables")).status).toBe("ok");
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it("clears the guard when the export fails", async () => {
    startMock.mockRejectedValue(new Error("disk full"));

    const failed = await execute("export.deliverables");
    expect(failed.status).toBe("disabled");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Export failed: disk full",
    );

    startMock.mockResolvedValue(jobSnapshot("job-2"));
    followMock.mockResolvedValue(["export/a.wav"]);
    expect((await execute("export.deliverables")).status).toBe("ok");
    expect(startMock).toHaveBeenCalledTimes(2);
  });
});
