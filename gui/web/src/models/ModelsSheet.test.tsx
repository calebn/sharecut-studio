import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapStatus } from "../api";
import * as api from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import {
  modelRow,
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../test/renderWithModels";
import { stubViewportShell } from "../test/viewportShell";
import { ModelsProvider } from "./ModelsProvider";
import { ModelsSheet } from "./ModelsSheet";
import { useModels } from "./useModels";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchBootstrapJob: vi.fn().mockResolvedValue(null),
    fetchBootstrapStatus: vi.fn(),
  };
});

const fetchStatus = vi.mocked(api.fetchBootstrapStatus);

afterEach(() => fetchStatus.mockReset());

function mount(
  rows = registryRows(),
  over: Parameters<typeof modelsApi>[0] extends infer F
    ? Partial<F>
    : never = {},
  shell: "desktop" | "phone" = "desktop",
) {
  stubViewportShell(shell);
  const api = modelsApi({ status: modelStatus(rows), ...over });
  const onClose = vi.fn();
  const view = render(<ModelsSheet open onClose={onClose} />, {
    wrapper: modelsWrapper(api),
  });
  return { api, onClose, ...view };
}

const names = () =>
  [...document.querySelectorAll(".sys-need-name")].map((el) => el.textContent);

describe("ModelsSheet", () => {
  it("does not call unknown audio-tool status unavailable while the initial status is loading", async () => {
    let resolveStatus: (status: BootstrapStatus) => void = () => undefined;
    fetchStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <ModelsSheet open onClose={vi.fn()} />
      </ModelsProvider>,
    );

    try {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Checking what is installed",
      );
      expect(screen.queryByText("Audio tools are unavailable")).toBeNull();
      expect(screen.queryByText(/Reinstall ShareCut Studio/)).toBeNull();
    } finally {
      await act(async () => {
        resolveStatus(
          modelStatus(registryRows(), {
            tools: {
              ffmpeg: { state: "missing", source: "unavailable", hint: null },
            },
          }),
        );
      });
    }

    await waitFor(() =>
      expect(screen.getByText("Audio tools are unavailable")).toBeTruthy(),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps an initial status failure truthful and recovers when status is retried", async () => {
    fetchStatus
      .mockRejectedValueOnce(new Error("Status request failed"))
      .mockResolvedValueOnce(modelStatus(registryRows()));
    function RetryStatus() {
      const { refresh } = useModels();
      return (
        <>
          <ModelsSheet open onClose={vi.fn()} />
          <button type="button" onClick={() => void refresh()}>
            Retry status request
          </button>
        </>
      );
    }
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <RetryStatus />
      </ModelsProvider>,
    );
    expect(await screen.findByText("Status request failed")).toBeVisible();
    expect(screen.queryByText("Checking what is installed")).toBeNull();
    expect(screen.queryByText("Audio tools are unavailable")).toBeNull();
    expect(screen.queryByText(/Reinstall ShareCut Studio/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry status request" }),
    );
    expect(await screen.findByText("Transcription")).toBeVisible();
    expect(screen.queryByText("Status request failed")).toBeNull();
    expect(screen.queryByText("Audio tools are unavailable")).toBeNull();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("does not warn when the loaded status confirms installed audio tools", () => {
    mount();
    expect(screen.queryByText("Audio tools are unavailable")).toBeNull();
  });

  it("lists a Model need row per capability, in the order a person meets them, with no Apply", async () => {
    mount();
    const dialog = screen.getByRole("dialog", { name: "Models" });
    expect(names()).toEqual([
      "Transcription",
      "Word timing",
      "Speaker split",
      "Noise reduction",
    ]);
    expect(within(dialog).queryByRole("button", { name: /apply/i })).toBeNull();
    expect(screen.queryByText(/Checking installed models/)).toBeNull();
    await expectNoA11yViolations(document.body);
  });

  it("writes size and state in each row's meta line", () => {
    mount();
    const metas = [...document.querySelectorAll(".sys-need-meta")].map(
      (el) => el.textContent,
    );
    expect(metas).toEqual([
      "Not installed · 1.6 GB",
      "Not installed · 360 MB",
      "Not installed · 25 MB",
      "Not installed · 0.3 MB",
    ]);
  });

  it("gets a model when Get is pressed, and nothing downloads on open", async () => {
    const { api } = mount();
    expect(api.download).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Get Noise reduction" }),
    );
    expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);
  });

  it("offers Fast, Balanced and Best under Transcription and picks a size without a dialog", async () => {
    const { api } = mount();
    const size = screen.getByRole("group", { name: "Size" });
    const buttons = within(size).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      null,
      null,
      null,
    ]);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Fast 75 MB",
      "Balanced 500 MB",
      "Best 1.6 GB",
    ]);
    for (const [name, b] of [
      ["Fast 75 MB", buttons[0]],
      ["Balanced 500 MB", buttons[1]],
      ["Best 1.6 GB", buttons[2]],
    ] as const) {
      expect(within(size).getByRole("button", { name })).toBe(b);
    }
    expect(within(size).getByRole("button", { name: /^Best/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(
      within(size).getByRole("button", { name: /^Balanced/ }),
    );
    expect(api.whisper.choose).toHaveBeenCalledWith("small.en");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("shows every state: installed has no control, a running download has a ring that cancels, a failure retries", async () => {
    const rows = registryRows().map((r) => {
      if (r.id === "whisper") return { ...r, state: "installed" as const };
      if (r.id === "rnnoise") return { ...r, state: "update_needed" as const };
      return r;
    });
    const { api } = mount(rows, {
      failures: {
        "speaker-ecapa": {
          kind: "network",
          plain: "Couldn't reach the server.",
        },
      },
    });
    const transcription = screen
      .getByText("Transcription")
      .closest(".sys-need")!;
    expect(
      within(transcription as HTMLElement).queryByRole("button", {
        name: /Get|Cancel/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Update Noise reduction" }),
    ).toBeEnabled();
    expect(screen.getByText("Couldn't reach the server.")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Try again Speaker split" }),
    );
    expect(api.download).toHaveBeenCalledWith(["speaker-ecapa"], undefined);
  });

  it("blocks the other Get buttons with the reason while one download runs", async () => {
    mount(registryRows(), {
      job: {
        id: "j1",
        kind: "bootstrap",
        components: ["whisper"],
        whisper_model: "large-v3-turbo",
        status: "running",
        download: {
          component: "whisper",
          bytes: 420_000_000,
          total: 1_600_000_000,
        },
      } as never,
    });
    expect(screen.getByText("420 MB of 1.6 GB")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Getting Transcription" }),
    ).toHaveAttribute("aria-valuenow", "26");
    await expectNoA11yViolations(document.body);
    const get = screen.getByRole("button", { name: "Get Noise reduction" });
    expect(get).toBeDisabled();
    expect(get).toHaveAccessibleDescription("Another download is running");
    expect(
      screen.getByRole("button", { name: "Cancel Transcription download" }),
    ).toBeEnabled();
    expect(
      within(screen.getByRole("group", { name: "Size" })).getAllByRole(
        "button",
      )[0],
    ).toBeDisabled();
  });

  it("says when the audio tools are unavailable", () => {
    const status = modelStatus(registryRows());
    status.tools = {
      ffmpeg: { state: "missing", source: "unavailable", hint: null },
    };
    const api = modelsApi({ status });
    render(<ModelsSheet open onClose={vi.fn()} />, {
      wrapper: modelsWrapper(api),
    });
    expect(screen.getByText("Audio tools are unavailable")).toBeTruthy();
  });

  it("is the full-height bottom sheet on a phone", () => {
    mount(registryRows(), {}, "phone");
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
    expect(names()).toHaveLength(4);
  });

  it("is a modal side sheet docked to the end edge on a desktop, not a centered card", () => {
    mount();
    const root = document.querySelector(".ui-dialog-root");
    expect(root).toHaveClass("ui-dialog-root--end");
    expect(screen.getByRole("dialog", { name: "Models" })).toBeVisible();
    expect(
      document.querySelector(".sys-sheet-end.models-sheet"),
    ).not.toBeNull();
    expect(document.querySelector(".sys-sheet-centered")).toBeNull();
    expect(document.querySelector(".bottom-sheet")).toBeNull();
  });

  it("closes from its Close button", async () => {
    const { onClose } = mount();
    await userEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it("lists only the models the server reports", () => {
    mount([modelRow({ id: "whisper", label: "Whisper" })]);
    expect(names()).toEqual(["Transcription"]);
  });
});
