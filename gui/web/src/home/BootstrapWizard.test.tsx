import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fetchBootstrapStatus, runBootstrap } from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import { BootstrapWizard } from "./BootstrapWizard";

const catalog = [
  {
    id: "small.en",
    label: "Balanced (English)",
    size: "~500 MB",
    description: "Good laptop default if disk is tight.",
  },
  {
    id: "large-v3-turbo",
    label: "Recommended",
    size: "~1.6 GB",
    description: "Lowest practical error for podcasts (multilingual). Default.",
  },
];

vi.mock("../api", () => ({
  waitForBootstrapJob: vi.fn(async (id: string) => ({
    id,
    kind: "bootstrap",
    components: ["ffmpeg", "whisper"],
    whisper_model: "large-v3-turbo",
    status: "ok",
    message: "Ready",
  })),
  fetchBootstrapStatus: vi.fn(async () => ({
    ready: false,
    whisper_model: "large-v3-turbo",
    whisper_models: catalog,
    components: {
      ffmpeg: { ok: false, required_for_first_run: true },
      whisper: { ok: false, required_for_first_run: true },
      rnnoise: { ok: false, required_for_first_run: false },
    },
    default_components: ["ffmpeg", "whisper"],
    optional_components: ["rnnoise"],
    cdn_base: false,
  })),
  runBootstrap: vi.fn(),
}));

const fetchMock = vi.mocked(fetchBootstrapStatus);
const runMock = vi.mocked(runBootstrap);

describe("BootstrapWizard", () => {
  it("renders setup copy and Speech model when assets are missing", async () => {
    const onReady = vi.fn();
    const { container } = render(
      <BootstrapWizard onReady={onReady} onSkip={vi.fn()} />,
    );
    expect(
      await screen.findByRole("heading", { name: "Set up Sharecut Studio" }),
    ).toBeTruthy();
    expect(container.querySelector(".box.elevated")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.getByLabelText("Speech model")).toBeTruthy();
    expect(screen.getByText(/lowest practical WER/i)).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("sends the selected whisper model when continuing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      },
    );
    runMock.mockResolvedValue({
      job: {
        id: "job1",
        kind: "bootstrap",
        components: [],
        whisper_model: "small.en",
        status: "queued",
      },
    });
    render(<BootstrapWizard onReady={vi.fn()} onSkip={vi.fn()} />);
    const select = await screen.findByLabelText("Speech model");
    await user.selectOptions(select, "small.en");
    expect(fetchMock).toHaveBeenCalledWith("small.en");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ whisper_model: "small.en" }),
    );
  });

  it("calls onReady when a model-scoped refresh reports ready", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    fetchMock.mockImplementation(async (model?: string) => ({
      ready: model === "small.en",
      whisper_model: model ?? "large-v3-turbo",
      whisper_models: catalog,
      components: {
        ffmpeg: { ok: true, required_for_first_run: true },
        whisper: { ok: model === "small.en", required_for_first_run: true },
        rnnoise: { ok: false, required_for_first_run: false },
      },
      default_components: ["ffmpeg", "whisper"],
      optional_components: ["rnnoise"],
      cdn_base: false,
    }));
    render(<BootstrapWizard onReady={onReady} onSkip={vi.fn()} />);
    expect(
      await screen.findByRole("heading", { name: "Set up Sharecut Studio" }),
    ).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("Speech model"), "small.en");
    expect(onReady).toHaveBeenCalled();
  });
});
