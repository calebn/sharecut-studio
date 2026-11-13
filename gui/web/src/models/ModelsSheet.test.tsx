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

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchBootstrapJob: vi.fn().mockResolvedValue(null),
    fetchBootstrapStatus: vi.fn(),
    runBootstrap: vi.fn(),
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

describe("ModelsSheet on a device without audio tools", () => {
  const unsupportedRows = () =>
    registryRows().map((r) =>
      modelRow({
        ...r,
        state: "unsupported",
        hint: "ShareCut can't transcribe audio on this device yet.",
      }),
    );

  it("says the tools are not there yet and offers no Get, size or retry", async () => {
    stubViewportShell("desktop");
    const { baseElement } = render(<ModelsSheet open onClose={vi.fn()} />, {
      wrapper: modelsWrapper(
        modelsApi({
          status: modelStatus(unsupportedRows(), {
            tools: {
              ffmpeg: {
                state: "unsupported",
                source: "not found",
                hint: "ShareCut can't process audio on this device yet.",
              },
            },
          }),
        }),
      ),
    });
    expect(
      await screen.findByText(
        "ShareCut can't process audio on this device yet.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("Not available")).toHaveLength(4);
    expect(screen.queryByText(/can't transcribe/)).toBeNull();
    expect(
      screen.queryByText("Reinstall ShareCut Studio to restore them."),
    ).toBeNull();
    expect(screen.queryByRole("group", { name: "Size" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^(Get|Try again)/ }),
    ).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await expectNoA11yViolations(baseElement);
  });
});

describe("ModelsSheet", () => {
  it("does not reuse the previous size's Get while another size is being checked", async () => {
    let finish!: (status: BootstrapStatus) => void;
    fetchStatus
      .mockResolvedValueOnce(modelStatus(registryRows()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <ModelsSheet open onClose={vi.fn()} />
      </ModelsProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Get Transcription" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^Balanced/ }));
    expect(
      screen.queryByRole("button", { name: "Get Transcription" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More for Transcription" }),
    ).toBeNull();
    await act(async () =>
      finish(
        modelStatus(
          registryRows().map((r) =>
            r.id === "whisper" ? modelRow({ ...r, model: "small.en" }) : r,
          ),
          { whisper_model: "small.en" },
        ),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Get Transcription" }),
    ).toBeVisible();
  });

  it("ignores an installed response for a superseded size", async () => {
    let balanced!: (status: BootstrapStatus) => void;
    let fast!: (status: BootstrapStatus) => void;
    const rows = registryRows().map((r) =>
      r.id === "whisper" ? modelRow({ ...r, state: "installed" }) : r,
    );
    fetchStatus
      .mockResolvedValueOnce(modelStatus(rows))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            balanced = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            fast = resolve;
          }),
      );
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <ModelsSheet open onClose={vi.fn()} />
      </ModelsProvider>,
    );
    await screen.findByRole("button", { name: "More for Transcription" });
    await userEvent.click(screen.getByRole("button", { name: /^Balanced/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Fast/ }));
    await act(async () =>
      balanced(
        modelStatus(
          rows.map((r) =>
            r.id === "whisper" ? modelRow({ ...r, model: "small.en" }) : r,
          ),
          { whisper_model: "small.en" },
        ),
      ),
    );
    expect(screen.getByRole("button", { name: /^Fast/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "More for Transcription" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Get Transcription" }),
    ).toBeNull();
    await act(async () =>
      fast(
        modelStatus(
          rows.map((r) =>
            r.id === "whisper"
              ? modelRow({ ...r, model: "tiny.en", state: "missing" })
              : r,
          ),
          { whisper_model: "tiny.en" },
        ),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Get Transcription" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /^Fast/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it.each(["missing", "installed"] as const)(
    "does not borrow another Whisper size's actions while checking or failed; retries to %s",
    async (state) => {
      let rejectStatus!: (error: Error) => void;
      let resolveRetry!: (status: BootstrapStatus) => void;
      const initial = registryRows().map((r) =>
        r.id === "whisper" ? modelRow({ ...r, state: "installed" }) : r,
      );
      fetchStatus
        .mockResolvedValueOnce(modelStatus(initial))
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectStatus = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRetry = resolve;
            }),
        );
      vi.mocked(api.runBootstrap).mockClear();
      stubViewportShell("desktop");
      render(
        <ModelsProvider>
          <ModelsSheet open onClose={vi.fn()} />
        </ModelsProvider>,
      );
      expect(
        await screen.findByRole("button", { name: "More for Transcription" }),
      ).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: /^Balanced/ }));
      expect(screen.getByRole("button", { name: /^Balanced/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.queryByRole("button", { name: "More for Transcription" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Get Transcription" }),
      ).toBeNull();
      expect(screen.getByText("Checking status · 500 MB")).toBeVisible();
      await act(async () =>
        rejectStatus(new Error("Selected status unavailable")),
      );
      expect(
        await screen.findByText("Selected status unavailable"),
      ).toBeVisible();
      expect(screen.getByText("Status unavailable · 500 MB")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "More for Transcription" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Get Transcription" }),
      ).toBeNull();
      await userEvent.click(
        screen.getByRole("button", {
          name: "Try again to check Transcription status",
        }),
      );
      await act(async () =>
        resolveRetry(
          modelStatus(
            initial.map((r) =>
              r.id === "whisper"
                ? modelRow({
                    ...r,
                    model: "small.en",
                    state,
                    size: "~500 MB",
                    size_bytes: 500_000_000,
                  })
                : r,
            ),
            { whisper_model: "small.en" },
          ),
        ),
      );
      expect(
        await screen.findByRole("button", {
          name:
            state === "installed"
              ? "More for Transcription"
              : "Get Transcription",
        }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: /^Balanced/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(api.runBootstrap).not.toHaveBeenCalled();
    },
  );
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
    expect(screen.queryByText("Checking what is installed")).toBeNull();
    expect(names()).toHaveLength(4);
  });

  it("keeps an initial status failure truthful and recovers when status is retried", async () => {
    fetchStatus
      .mockRejectedValueOnce(new Error("Status request failed"))
      .mockResolvedValueOnce(modelStatus(registryRows()));
    stubViewportShell("desktop");
    render(
      <ModelsProvider>
        <ModelsSheet open onClose={vi.fn()} />
      </ModelsProvider>,
    );
    expect(await screen.findByText("Status request failed")).toBeVisible();
    expect(screen.queryByText("Checking what is installed")).toBeNull();
    expect(screen.queryByText("Audio tools are unavailable")).toBeNull();
    expect(screen.queryByText(/Reinstall ShareCut Studio/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Try again to check model status" }),
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
      "Not installed · 80 MB",
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
        "speaker-ecapa/": {
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
      screen.queryByRole("button", { name: "Update Noise reduction" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Noise reduction" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Update Noise reduction" }),
    );
    expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);
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
        failed_components: [],
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
