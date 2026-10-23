import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ModelsFixture,
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import { ApiError, type ModelNeeded } from "../../utils/apiError";
import { ANOTHER_DOWNLOAD_REASON } from "../activity";
import type { DownloadOutcome } from "../types";
import { ModelsContext } from "../useModels";
import { ModelGateDialog, ModelGateHint } from "./ModelGate";
import { type GateResult, type ModelNeed, useModelGate } from "./useModelGate";

type Action = (ctx: { afterDownload: boolean }) => Promise<string>;

function Harness({ action, needs }: { action: Action; needs?: ModelNeed[] }) {
  const gate = useModelGate();
  const [out, setOut] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void gate
            .run(action, needs)
            .then((r: GateResult<string>) =>
              setOut(r.kind === "ran" ? r.value : `declined ${r.id}`),
            )
            .catch((e: unknown) => setOut(`threw ${(e as Error).message}`))
        }
      >
        Go
      </button>
      <output>{out}</output>
      <ModelGateDialog gate={gate} />
      <ModelGateHint gate={gate} actionLabel="Go" />
    </>
  );
}

function rows(installed: string[] = []) {
  return registryRows().map((r) =>
    installed.includes(r.id) ? { ...r, state: "installed" as const } : r,
  );
}

function fixture(
  installed: string[] = [],
  over: Partial<ModelsFixture> = {},
): ModelsFixture {
  return { status: modelStatus(rows(installed)), ...over };
}

function mount(
  action: Action,
  needs: ModelNeed[] | undefined,
  first: ModelsFixture,
) {
  let current = modelsApi(first);
  const Wrapper = (props: { children: React.ReactNode }) => (
    <ModelsContext.Provider value={current}>
      {props.children}
    </ModelsContext.Provider>
  );
  const ui = <Harness action={action} needs={needs} />;
  const view = render(ui, { wrapper: Wrapper });
  return {
    get api() {
      return current;
    },
    swap(next: ModelsFixture) {
      current = { ...modelsApi(next), download: current.download };
      view.rerender(ui);
    },
  };
}

const ok = (): Action => vi.fn(async () => "done");

function modelNeeded(over: Partial<ModelNeeded> = {}): ApiError {
  const model: ModelNeeded = {
    id: "word-aligner",
    variant: null,
    label: "Word aligner",
    purpose: "precise word boundaries",
    size: "~360 MB",
    sizeBytes: null,
    state: "missing",
    ...over,
  };
  return new ApiError("Needs the aligner.", "model_needed", 409, model);
}

afterEach(() => vi.unstubAllGlobals());

describe("useModelGate", () => {
  it("runs at once when the model is installed", async () => {
    const action = ok();
    mount(action, [{ id: "whisper" }], fixture(["whisper"]));
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith({ afterDownload: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks when the model is missing and makes no request until Download", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const action = ok();
    const view = mount(action, [{ id: "whisper" }], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(
      await screen.findByRole("dialog", { name: /Download Whisper\?/ }),
    ).toBeInTheDocument();
    expect(view.api.download).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("downloads the named Whisper size on accept, then runs the action once", async () => {
    const action = ok();
    const view = mount(
      action,
      [{ id: "whisper", variant: "small.en", installed: false }],
      fixture(["whisper"]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(view.api.download).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "small.en",
    });
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({ afterDownload: true });
  });

  it("downloads a model that has no variants with no options", async () => {
    const view = mount(ok(), [{ id: "speaker-ecapa" }], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(view.api.download).toHaveBeenCalledWith(
      ["speaker-ecapa"],
      undefined,
    );
  });

  it("stays open on a failed download and offers Retry without running", async () => {
    const action = ok();
    const download = vi
      .fn<() => Promise<DownloadOutcome>>()
      .mockResolvedValueOnce({ kind: "failed", failed: ["word-aligner"] })
      .mockResolvedValue({ kind: "ok" });
    const view = mount(
      action,
      [{ id: "word-aligner" }],
      fixture([], { download }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(action).not.toHaveBeenCalled();
    await userEvent.click(retry);
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(view.api.download).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("disables Download with the reason while another download runs", async () => {
    const status = modelStatus(rows());
    const job = {
      id: "j",
      kind: "bootstrap",
      status: "running",
      components: ["rnnoise"],
    } as never;
    mount(ok(), [{ id: "word-aligner" }], { status, job });
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    const download = await screen.findByRole("button", { name: "Download" });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute("title", ANOTHER_DOWNLOAD_REASON);
  });

  it("returns to ask when the download is cancelled", async () => {
    const download = vi.fn(
      async (): Promise<DownloadOutcome> => ({ kind: "cancelled" }),
    );
    mount(ok(), [{ id: "word-aligner" }], fixture([], { download }));
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(
      await screen.findByRole("button", { name: "Download" }),
    ).toBeEnabled();
    expect(screen.queryByText("done")).toBeNull();
  });

  it("does not run on Not now, shows the hint, and asks again next time", async () => {
    const action = ok();
    mount(action, [{ id: "word-aligner" }], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(
      await screen.findByText("declined word-aligner"),
    ).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Word aligner is not downloaded. Go will ask again./),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/will ask again/)).toBeNull();
  });

  it("refreshes, asks for the model a stale 409 names, and resumes", async () => {
    const action = vi
      .fn<Action>()
      .mockRejectedValueOnce(modelNeeded())
      .mockResolvedValue("done");
    const view = mount(action, [], fixture(["word-aligner"]));
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(view.api.refresh).toHaveBeenCalledTimes(1);
    expect(view.api.download).toHaveBeenCalledWith(["word-aligner"], undefined);
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenLastCalledWith({ afterDownload: true });
  });

  it("rethrows a 409 for a model it already downloaded in this run", async () => {
    const action = vi.fn<Action>().mockRejectedValue(modelNeeded());
    mount(action, [], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(
      await screen.findByText("threw Needs the aligner."),
    ).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("chains Whisper then the aligner through two prompts", async () => {
    const action = vi
      .fn<Action>()
      .mockRejectedValueOnce(modelNeeded({ id: "whisper", label: "Whisper" }))
      .mockRejectedValueOnce(modelNeeded())
      .mockResolvedValue("done");
    const view = mount(action, [], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: /Word aligner/ }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(view.api.download).toHaveBeenCalledTimes(2);
  });

  it("rethrows once it has asked three times", async () => {
    const ids = ["whisper", "word-aligner", "rnnoise", "speaker-ecapa"];
    const action = vi.fn<Action>();
    for (const id of ids) {
      action.mockRejectedValueOnce(modelNeeded({ id, label: id }));
    }
    mount(action, [], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    for (let i = 0; i < 3; i++) {
      await userEvent.click(
        await screen.findByRole("button", { name: "Download" }),
      );
      await waitFor(() => expect(action).toHaveBeenCalledTimes(i + 2));
    }
    expect(
      await screen.findByText(/threw Needs the aligner/),
    ).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(4);
  });

  it("passes any other error through unchanged", async () => {
    const action = vi.fn<Action>().mockRejectedValue(new Error("boom"));
    mount(action, [{ id: "whisper" }], fixture(["whisper"]));
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("threw boom")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs with no prompt and no request for a guest", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const action = ok();
    render(<Harness action={action} needs={[{ id: "whisper" }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an unmounted prompt as declined", async () => {
    const action = ok();
    let settled: GateResult<string> | null = null;
    function Once() {
      const gate = useModelGate();
      return (
        <button
          type="button"
          onClick={() =>
            void gate.run(action, [{ id: "word-aligner" }]).then((r) => {
              settled = r;
            })
          }
        >
          Go
        </button>
      );
    }
    const view = render(
      <ModelsContext.Provider value={modelsApi(fixture())}>
        <Once />
      </ModelsContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    view.unmount();
    await waitFor(() =>
      expect(settled).toMatchObject({ kind: "declined", id: "word-aligner" }),
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("asks again when the caller says the size is not installed", async () => {
    const action = ok();
    mount(
      action,
      [{ id: "whisper", variant: "small.en", installed: false }],
      fixture(["whisper"]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("skips the prompt when the caller says the size is installed", async () => {
    const action = ok();
    mount(
      action,
      [{ id: "whisper", variant: "small.en", installed: true }],
      fixture(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
  });

  it("leaves the check to the server while status has not loaded", async () => {
    const action = ok();
    const api = { ...modelsApi(fixture()), models: null };
    render(
      <ModelsContext.Provider value={api}>
        <Harness action={action} needs={[{ id: "whisper" }]} />
      </ModelsContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Continue when the model is installed elsewhere while it asks", async () => {
    const action = ok();
    const view = mount(action, [{ id: "word-aligner" }], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByRole("button", { name: "Download" });
    view.swap(fixture(["word-aligner"]));
    const next = await screen.findByRole("button", { name: "Continue" });
    expect(action).not.toHaveBeenCalled();
    await userEvent.click(next);
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(view.api.download).not.toHaveBeenCalled();
  });

  it("does not offer Cancel for another Whisper size's download", async () => {
    const job = {
      id: "j",
      kind: "bootstrap",
      status: "running",
      components: ["whisper"],
      download: { component: "whisper", bytes: 10, total: 100 },
    } as never;
    mount(ok(), [{ id: "whisper", variant: "small.en", installed: false }], {
      status: modelStatus(rows()),
      job,
    });
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    const download = await screen.findByRole("button", { name: "Download" });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute("title", ANOTHER_DOWNLOAD_REASON);
    expect(
      screen.queryByRole("button", { name: "Cancel download" }),
    ).toBeNull();
  });

  it("settles a 409 that arrives after the host unmounted as declined", async () => {
    let fail: (e: unknown) => void = () => undefined;
    const action: Action = vi.fn(
      () =>
        new Promise<string>((_, reject) => {
          fail = reject;
        }),
    );
    let settled: GateResult<string> | null = null;
    function Once() {
      const gate = useModelGate();
      return (
        <button
          type="button"
          onClick={() =>
            void gate.run(action).then((r) => {
              settled = r;
            })
          }
        >
          Go
        </button>
      );
    }
    const view = render(
      <ModelsContext.Provider value={modelsApi(fixture())}>
        <Once />
      </ModelsContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    view.unmount();
    fail(modelNeeded());
    await waitFor(() =>
      expect(settled).toMatchObject({ kind: "declined", id: "word-aligner" }),
    );
  });

  it("clears the decline hint once the declined model installs", async () => {
    const view = mount(ok(), [{ id: "word-aligner" }], fixture());
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Not now" }),
    );
    expect(await screen.findByText(/will ask again/)).toBeInTheDocument();

    view.swap(fixture(["word-aligner"]));
    await waitFor(() =>
      expect(screen.queryByText(/will ask again/)).toBeNull(),
    );
  });

  it("does not run the action when the gate was reset during the download", async () => {
    let finish: (outcome: DownloadOutcome) => void = () => undefined;
    const download = vi.fn(
      () =>
        new Promise<DownloadOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const action = ok();
    function Resettable() {
      const gate = useModelGate();
      return (
        <>
          <button
            type="button"
            onClick={() => void gate.run(action, [{ id: "word-aligner" }])}
          >
            Go
          </button>
          <button type="button" onClick={gate.reset}>
            Reset
          </button>
          <ModelGateDialog gate={gate} />
        </>
      );
    }
    render(
      <ModelsContext.Provider
        value={modelsApi({ status: modelStatus(rows()), download })}
      >
        <Resettable />
      </ModelsContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    await screen.findByRole("button", { name: "Cancel download" });
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => finish({ kind: "ok" }));
    expect(action).not.toHaveBeenCalled();
  });
});
