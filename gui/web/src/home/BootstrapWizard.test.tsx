import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ModelsProvider } from "../models/ModelsProvider";
import { expectNoA11yViolations } from "../test/a11y";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../test/renderWithModels";
import { BootstrapWizard } from "./BootstrapWizard";

vi.mock("../api", () => ({
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
  cancelBootstrap: vi.fn(),
}));

const fetchStatus = vi.mocked(api.fetchBootstrapStatus);
const fetchJob = vi.mocked(api.fetchBootstrapJob);
const run = vi.mocked(api.runBootstrap);
const wait = vi.mocked(api.waitForBootstrapJob);

function rowByName(name: string): HTMLElement {
  return screen.getByText(name, { selector: "span" }).closest("li")!;
}

describe("BootstrapWizard rows", () => {
  it("lists the registry rows in order with tier defaults", async () => {
    const { container } = renderWithModels(
      <BootstrapWizard onReady={vi.fn()} onSkip={vi.fn()} />,
      { status: modelStatus(registryRows()) },
    );
    expect(
      screen.getByRole("heading", { name: "Set up ShareCut Studio" }),
    ).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-model"))).toEqual([
      "whisper",
      "rnnoise",
      "word-aligner",
      "speaker-ecapa",
    ]);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const required = screen.getByRole("checkbox", { name: "Whisper" });
    expect(required).toBeDisabled();
    expect(required).toHaveAccessibleDescription(/Required for transcription/);
    expect(screen.getByRole("checkbox", { name: "RNNoise" })).toBeEnabled();
    expect(screen.getByText("Download 1.6 GB")).toBeTruthy();
    expect(
      screen.getByText("You can download these later from Models."),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("puts the size picker inside the row that owns the variants", async () => {
    const user = userEvent.setup();
    const { api: models } = renderWithModels(
      <BootstrapWizard onReady={vi.fn()} />,
      { status: modelStatus(registryRows()) },
    );
    const whisper = within(rowByName("Whisper"));
    const select = whisper.getByRole("combobox", { name: "Whisper size" });
    expect(select).toHaveValue("large-v3-turbo");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    await user.selectOptions(select, "small.en");
    expect(models.whisper.choose).toHaveBeenCalledWith("small.en");
  });

  it("leaves installed models out of the selection", () => {
    const rows = registryRows();
    rows[1] = { ...rows[1]!, state: "installed" };
    renderWithModels(<BootstrapWizard onReady={vi.fn()} />, {
      status: modelStatus(rows),
    });
    expect(screen.queryByRole("checkbox", { name: "RNNoise" })).toBeNull();
    expect(within(rowByName("RNNoise")).getByRole("status")).toHaveTextContent(
      "Installed",
    );
  });

  it("sends the checked, not-installed ids on Continue, once", async () => {
    const user = userEvent.setup();
    const { api: models } = renderWithModels(
      <BootstrapWizard onReady={vi.fn()} />,
      { status: modelStatus(registryRows()) },
    );
    await user.click(screen.getByRole("checkbox", { name: "Speaker model" }));
    expect(models.download).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(models.download).toHaveBeenCalledTimes(1);
    expect(models.download).toHaveBeenCalledWith([
      "whisper",
      "rnnoise",
      "speaker-ecapa",
    ]);
  });

  it("counts models when a size is unknown", async () => {
    const user = userEvent.setup();
    renderWithModels(<BootstrapWizard onReady={vi.fn()} />, {
      status: modelStatus(registryRows()),
    });
    await user.click(screen.getByRole("checkbox", { name: "Word aligner" }));
    expect(screen.getByText("Download 3 models")).toBeTruthy();
  });

  it("shows the live bar on the current row and the others waiting", async () => {
    const { container } = renderWithModels(
      <BootstrapWizard onReady={vi.fn()} onSkip={vi.fn()} />,
      {
        status: modelStatus(registryRows()),
        job: {
          id: "j",
          kind: "bootstrap",
          components: ["whisper", "rnnoise"],
          whisper_model: "large-v3-turbo",
          status: "running",
          download: {
            component: "whisper",
            bytes: 420_000_000,
            total: 1_600_000_000,
          },
        },
      },
    );
    expect(
      within(rowByName("Whisper")).getByRole("progressbar"),
    ).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
    expect(within(rowByName("RNNoise")).getByRole("status")).toHaveTextContent(
      "Waiting",
    );
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it("keeps a failed row with plain text and Retry for just that row", async () => {
    const user = userEvent.setup();
    const { api: models, container } = renderWithModels(
      <BootstrapWizard onReady={vi.fn()} />,
      {
        status: modelStatus(registryRows()),
        failures: {
          rnnoise: {
            kind: "network",
            plain: "Couldn't reach the download server.",
          },
        },
      },
    );
    const row = within(rowByName("RNNoise"));
    expect(row.getByRole("alert")).toHaveTextContent(
      "Couldn't reach the download server.",
    );
    await user.click(row.getByRole("button", { name: "Retry RNNoise" }));
    expect(models.download).toHaveBeenCalledWith(["rnnoise"]);
    await expectNoA11yViolations(container);
  });

  it("calls onReady for a machine that is already set up", async () => {
    const onReady = vi.fn();
    renderWithModels(<BootstrapWizard onReady={onReady} />, {
      status: modelStatus(registryRows(), { ready: true }),
    });
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it("explains missing audio tools with the setup guide", () => {
    renderWithModels(<BootstrapWizard onReady={vi.fn()} />, {
      status: modelStatus(registryRows(), {
        tools: {
          ffmpeg: { state: "missing", source: "not found", hint: null },
        },
      }),
    });
    expect(screen.getByText(/Audio tools: unavailable/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "source setup guide" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/calebn/sharecut-studio/blob/main/docs/setup.md#acquire-the-pinned-ffmpeg-pair",
    );
  });
});

describe("BootstrapWizard with the provider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fetchJob.mockResolvedValue(null);
    fetchStatus.mockResolvedValue(modelStatus(registryRows()));
  });

  function mount(onReady = vi.fn()) {
    render(
      <ModelsProvider>
        <BootstrapWizard onReady={onReady} onSkip={vi.fn()} />
      </ModelsProvider>,
    );
    return onReady;
  }

  it("posts nothing before Continue, then one run with the selected ids", async () => {
    const user = userEvent.setup();
    run.mockResolvedValue({
      job: {
        id: "j1",
        kind: "bootstrap",
        components: ["whisper", "rnnoise"],
        whisper_model: "large-v3-turbo",
        status: "queued",
      },
    });
    wait.mockResolvedValue({
      id: "j1",
      kind: "bootstrap",
      components: ["whisper", "rnnoise"],
      whisper_model: "large-v3-turbo",
      status: "ok",
    });
    mount();
    await screen.findByRole("button", { name: "Continue" });
    expect(run).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      components: ["whisper", "rnnoise"],
      whisper_model: "large-v3-turbo",
      force: false,
    });
  });

  it("sends the chosen Whisper size and finishes when the machine is ready", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    fetchStatus.mockImplementation(async (model?: string) =>
      model === "small.en"
        ? modelStatus(
            registryRows().map((r) =>
              r.id === "whisper"
                ? {
                    ...r,
                    model: "small.en",
                    size: "~500 MB",
                    size_bytes: 500_000_000,
                  }
                : r,
            ),
            { whisper_model: "small.en" },
          )
        : modelStatus(registryRows()),
    );
    run.mockResolvedValue({
      job: {
        id: "j1",
        kind: "bootstrap",
        components: ["whisper", "rnnoise"],
        whisper_model: "small.en",
        status: "queued",
      },
    });
    wait.mockImplementation(async () => {
      fetchStatus.mockResolvedValue(
        modelStatus(
          registryRows().map((r) => ({ ...r, state: "installed" as const })),
          { ready: true, whisper_model: "small.en" },
        ),
      );
      return {
        id: "j1",
        kind: "bootstrap",
        components: ["whisper", "rnnoise"],
        whisper_model: "small.en",
        status: "ok",
      };
    });
    render(
      <ModelsProvider>
        <BootstrapWizard onReady={onReady} />
      </ModelsProvider>,
    );
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Whisper size" }),
      "small.en",
    );
    await screen.findByText("Download 500 MB");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ whisper_model: "small.en" }),
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it("keeps the wizard open on a failure and retries only that row", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    run.mockResolvedValue({
      job: {
        id: "j1",
        kind: "bootstrap",
        components: ["whisper", "rnnoise"],
        whisper_model: "large-v3-turbo",
        status: "queued",
      },
    });
    wait.mockResolvedValueOnce({
      id: "j1",
      kind: "bootstrap",
      components: ["whisper", "rnnoise"],
      whisper_model: "large-v3-turbo",
      status: "error",
      result: {
        results: {
          whisper: { ok: true },
          rnnoise: {
            ok: false,
            error: "Couldn't reach the download server.",
            failure: {
              kind: "network",
              status: null,
              plain: "Couldn't reach the download server.",
            },
          },
        },
      },
    });
    fetchStatus.mockResolvedValueOnce(modelStatus(registryRows()));
    mount(onReady);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    fetchStatus.mockResolvedValue(
      modelStatus(
        registryRows().map((r) =>
          r.id === "whisper" ? { ...r, state: "installed" as const } : r,
        ),
      ),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't reach the download server.");
    expect(onReady).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry RNNoise" })).toBeTruthy();
  });

  it("tells a second tab's running download from an idle wizard", async () => {
    fetchJob.mockResolvedValue({
      id: "other",
      kind: "bootstrap",
      components: ["whisper"],
      whisper_model: "large-v3-turbo",
      status: "running",
      download: { component: "whisper", bytes: 10, total: null },
    });
    wait.mockReturnValue(new Promise(() => undefined));
    mount();
    const bar = await screen.findByRole("progressbar");
    expect(bar).not.toHaveAttribute("value");
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
  });
});

describe("BootstrapWizard before status", () => {
  it("shows the load error with Skip", async () => {
    vi.mocked(api.fetchBootstrapStatus).mockRejectedValue(new Error("offline"));
    vi.mocked(api.fetchBootstrapJob).mockResolvedValue(null);
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelsProvider>
        <BootstrapWizard onReady={vi.fn()} onSkip={onSkip} />
      </ModelsProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalled();
  });
});
