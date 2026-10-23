import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { pipelineJobSnapshot } from "../../test/fixtures";
import {
  modelRow,
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../../test/renderWithModels";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { JobModelDownload } from "./JobModelDownload";

const runPointerCommand = vi.hoisted(() => vi.fn());
vi.mock("../../commands/pointer", () => ({ runPointerCommand }));

const RNNOISE = {
  id: "rnnoise",
  model: "rnnoise",
  label: "Noise reduction (RNNoise)",
  purpose: "noise reduction",
  size: "~0.3 MB",
  size_bytes: 297_646,
  command: "podcast bootstrap --component rnnoise",
  state: "missing",
};

function failed(over: Partial<PipelineJobSnapshot> = {}) {
  return pipelineJobSnapshot({
    status: "error",
    error: "needs Noise reduction (RNNoise)",
    error_code: "model_needed",
    error_model: RNNOISE,
    ...over,
  });
}

function setup(job: PipelineJobSnapshot | null, rows = registryRows()) {
  const api = modelsApi({ status: modelStatus(rows) });
  const view = render(<JobModelDownload job={job} />, {
    wrapper: modelsWrapper(api),
  });
  return { api, ...view };
}

describe("JobModelDownload", () => {
  beforeEach(() => {
    runPointerCommand.mockReset();
    useDawStore.setState({
      projectEpoch: 1,
      statusAnnouncement: "",
      statusAnnouncementSeq: 0,
    });
  });

  it("offers Download beside a job that failed for a model, and opens nothing by itself", () => {
    setup(failed());

    expect(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing for ok jobs, plain errors, other codes, no job or an installed model", () => {
    const rows = registryRows().map((r) =>
      r.id === "rnnoise" ? { ...r, state: "installed" as const } : r,
    );
    const cases: Array<[PipelineJobSnapshot | null, typeof rows | undefined]> =
      [
        [pipelineJobSnapshot({ status: "ok" }), undefined],
        [pipelineJobSnapshot({ status: "error", error: "boom" }), undefined],
        [failed({ error_code: "no_mix" }), undefined],
        [failed({ error_model: null }), undefined],
        [null, undefined],
        [failed(), rows],
      ];
    for (const [job, withRows] of cases) {
      const { container, unmount } = setup(job, withRows);
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("renders nothing when the models list has no row for the model", () => {
    const rows = registryRows().filter((r) => r.id !== "rnnoise");
    const { container } = setup(failed(), rows);
    expect(container.textContent).toBe("");
  });

  it("keeps a second Download behind the first one's modal dialog", async () => {
    const user = userEvent.setup();
    const api = modelsApi({ status: modelStatus(registryRows()) });
    render(
      <div data-daw-app-chrome="">
        <JobModelDownload job={failed()} />
        <JobModelDownload job={failed()} />
      </div>,
      { wrapper: modelsWrapper(api) },
    );
    const name = "Download Noise reduction (RNNoise)";
    await user.click(screen.getAllByRole("button", { name })[0] as HTMLElement);

    expect(await screen.findAllByRole("dialog")).toHaveLength(1);
    const chrome = document.querySelector<HTMLElement>("[data-daw-app-chrome]");
    expect(chrome?.inert).toBe(true);
  });

  it("renders nothing without a models provider", () => {
    const { container } = render(<JobModelDownload job={failed()} />);
    expect(container.textContent).toBe("");
  });

  it("asks on click only, then downloads and says what to press for a pipeline job", async () => {
    const user = userEvent.setup();
    const { api } = setup(failed({ kind: "pipeline" }));
    await user.click(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    );
    expect(api.download).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Download" }));

    expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Noise reduction (RNNoise) downloaded. Press Run again; From step skips the steps that finished.",
      ),
    );
    expect(runPointerCommand).not.toHaveBeenCalled();
    const done = await screen.findByText(
      "Noise reduction (RNNoise) downloaded.",
    );
    expect(document.activeElement).toBe(done);
  });

  it("names the next step for each other kind", async () => {
    const copy: Record<string, string> = {
      export: "Export again.",
      bounce: "Bounce again.",
      split_speakers: "Split again.",
      analyze: "Try again.",
    };
    for (const [kind, text] of Object.entries(copy)) {
      const user = userEvent.setup();
      const { unmount } = setup(failed({ kind }));
      await user.click(
        screen.getByRole("button", {
          name: "Download Noise reduction (RNNoise)",
        }),
      );
      await user.click(await screen.findByRole("button", { name: "Download" }));
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          `Noise reduction (RNNoise) downloaded. ${text}`,
        ),
      );
      unmount();
    }
  });

  it("refreshes the mix once after a render preview failure", async () => {
    const user = userEvent.setup();
    setup(failed({ kind: "render_preview" }));
    await user.click(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(runPointerCommand).toHaveBeenCalledExactlyOnceWith(
        "render.refreshMix",
      ),
    );
  });

  it("does not refresh a project the person has since left", async () => {
    const user = userEvent.setup();
    const { api } = setup(failed({ kind: "render_preview" }));
    vi.mocked(api.download).mockImplementation(async () => {
      useDawStore.setState({ projectEpoch: 2 });
      return { kind: "ok" };
    });
    await user.click(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Download" }));

    await waitFor(() => expect(api.download).toHaveBeenCalled());
    await act(async () => undefined);
    expect(runPointerCommand).not.toHaveBeenCalled();
  });

  it("leaves the button and announces nothing when the person says Not now", async () => {
    const user = userEvent.setup();
    setup(failed({ kind: "render_preview" }));
    await user.click(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    ).toBeTruthy();
    expect(runPointerCommand).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("says nothing when the models list changed under the button and no download ran", async () => {
    const user = userEvent.setup();
    const { api } = setup(failed({ kind: "render_preview" }));
    Object.assign(api, { models: [] });
    await user.click(
      screen.getByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.download).not.toHaveBeenCalled();
    expect(runPointerCommand).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("asks for the Whisper size the job needed", async () => {
    const user = userEvent.setup();
    const { api } = setup(
      failed({
        error_model: {
          ...RNNOISE,
          id: "whisper",
          model: "small.en",
          label: "Whisper",
          size: "~500 MB",
        },
      }),
      [modelRow({ id: "whisper", label: "Whisper", model: "large-v3-turbo" })],
    );
    await user.click(screen.getByRole("button", { name: "Download Whisper" }));
    await user.click(await screen.findByRole("button", { name: "Download" }));

    expect(api.download).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "small.en",
    });
  });
});
