import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../test/renderWithModels";
import { ModelsDialog } from "./ModelsDialog";
import { ModelsProvider } from "./ModelsProvider";

vi.mock("../api", () => ({
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
  cancelBootstrap: vi.fn(),
}));

function row(label: string): HTMLElement {
  return screen.getByText(label, { selector: "span" }).closest("li")!;
}

const closed = () => undefined;

describe("ModelsDialog", () => {
  it("lists every model in server order with state, size and purpose", async () => {
    const rows = registryRows();
    rows[1] = { ...rows[1]!, state: "installed" };
    rows[2] = { ...rows[2]!, state: "update_needed" };
    const { baseElement } = renderWithModels(
      <ModelsDialog open onClose={closed} />,
      { status: modelStatus(rows) },
    );
    expect(screen.getByRole("dialog", { name: "Models" })).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-model"))).toEqual([
      "whisper",
      "rnnoise",
      "word-aligner",
      "speaker-ecapa",
    ]);
    expect(within(row("Whisper")).getByText("~1.6 GB")).toBeTruthy();
    expect(within(row("Whisper")).getByText("Transcription")).toBeTruthy();
    expect(within(row("Whisper")).getByRole("status")).toHaveTextContent(
      "Not downloaded",
    );
    expect(
      within(row("Noise reduction (RNNoise)")).getByRole("status"),
    ).toHaveTextContent("Installed");
    expect(
      within(row("Noise reduction (RNNoise)")).queryByRole("button"),
    ).toBeNull();
    expect(
      within(row("Word aligner")).getByRole("button", {
        name: "Update Word aligner",
      }),
    ).toBeTruthy();
    expect(
      within(row("Speaker model")).getByRole("button", {
        name: "Download Speaker model",
      }),
    ).toBeTruthy();
    await expectNoA11yViolations(baseElement);
  });

  it("keeps the Whisper size picker in its row", () => {
    renderWithModels(<ModelsDialog open onClose={closed} />, {
      status: modelStatus(registryRows()),
    });
    expect(
      within(row("Whisper")).getByRole("combobox", { name: "Whisper size" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("downloads just the row that was clicked", async () => {
    const user = userEvent.setup();
    const { api: models } = renderWithModels(
      <ModelsDialog open onClose={closed} />,
      { status: modelStatus(registryRows()) },
    );
    await user.click(
      within(row("Word aligner")).getByRole("button", {
        name: "Download Word aligner",
      }),
    );
    expect(models.download).toHaveBeenCalledTimes(1);
    expect(models.download).toHaveBeenCalledWith(["word-aligner"]);
  });

  it("disables the other rows with a reason while one downloads, and cancels the running one", async () => {
    const user = userEvent.setup();
    const { api: models, baseElement } = renderWithModels(
      <ModelsDialog open onClose={closed} />,
      {
        status: modelStatus(registryRows()),
        job: {
          id: "j",
          kind: "bootstrap",
          components: ["whisper"],
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
    expect(within(row("Whisper")).getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "420 MB of 1.6 GB",
    );
    for (const [label, name] of [
      ["Noise reduction (RNNoise)", "Download Noise reduction (RNNoise)"],
      ["Word aligner", "Download Word aligner"],
      ["Speaker model", "Download Speaker model"],
    ] as const) {
      const button = within(row(label)).getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Another download is running");
    }
    expect(within(row("Whisper")).getByRole("combobox")).toBeDisabled();
    await expectNoA11yViolations(baseElement);
    await user.click(
      within(row("Whisper")).getByRole("button", {
        name: "Cancel Whisper download",
      }),
    );
    expect(models.cancel).toHaveBeenCalledTimes(1);
  });

  it("shows a failed row's plain text and fix hint with Retry", async () => {
    const { baseElement } = renderWithModels(
      <ModelsDialog open onClose={closed} />,
      {
        status: modelStatus(registryRows()),
        failures: {
          "word-aligner": {
            kind: "network",
            plain:
              "Couldn't reach the download server. Check your internet connection and try again.",
          },
        },
      },
    );
    const failed = within(row("Word aligner"));
    expect(failed.getByRole("alert")).toHaveTextContent(
      "Couldn't reach the download server.",
    );
    expect(
      failed.getByText(/Check your internet connection, then retry/),
    ).toBeTruthy();
    expect(
      failed.getByRole("button", { name: "Retry Word aligner" }),
    ).toBeEnabled();
    await expectNoA11yViolations(baseElement);
  });

  it("renders nothing while closed", () => {
    renderWithModels(<ModelsDialog open={false} onClose={closed} />, {
      status: modelStatus(registryRows()),
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the load error when status never arrived", () => {
    // A provider whose first status fetch fails has no rows yet.
    vi.mocked(api.fetchBootstrapStatus).mockRejectedValue(new Error("offline"));
    vi.mocked(api.fetchBootstrapJob).mockResolvedValue(null);
    render(
      <ModelsProvider>
        <ModelsDialog open onClose={closed} />
      </ModelsProvider>,
    );
    return waitFor(() => expect(screen.getByText("offline")).toBeTruthy());
  });

  it("posts nothing when it is opened and closed", async () => {
    const user = userEvent.setup();
    vi.mocked(api.runBootstrap).mockReset();
    vi.mocked(api.fetchBootstrapStatus).mockResolvedValue(
      modelStatus(registryRows()),
    );
    vi.mocked(api.fetchBootstrapJob).mockResolvedValue(null);
    const onClose = vi.fn();
    render(
      <ModelsProvider>
        <ModelsDialog open onClose={onClose} />
      </ModelsProvider>,
    );
    await screen.findByText("Whisper", { selector: "span" });
    await user.click(screen.getByRole("button", { name: "Close Models" }));
    expect(onClose).toHaveBeenCalled();
    expect(api.runBootstrap).not.toHaveBeenCalled();
  });
});
