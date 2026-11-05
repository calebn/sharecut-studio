import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { runPointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { answerQuestions } from "../test/ask";
import {
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../test/renderWithModels";
import { ModelNeedRow, ModelNeedRowView } from "./ModelNeedRow";
import type { ModelState } from "./types";

vi.mock("../commands/pointer", () => ({ runPointerCommand: vi.fn() }));

const WHISPER = {
  id: "whisper",
  variant: "large-v3-turbo",
  label: "Whisper",
  size: "~1.6 GB",
};

function view(over: Partial<Parameters<typeof ModelNeedRowView>[0]> = {}) {
  const onGet = vi.fn();
  const onCancel = vi.fn();
  const result = render(
    <ModelNeedRowView
      placement="need"
      model={WHISPER}
      state={{ kind: "missing" }}
      onGet={onGet}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onGet, onCancel, ...result };
}

describe("ModelNeedRowView, need placement", () => {
  it("says what is missing and its size, with Get", async () => {
    const { onGet, container } = view();
    expect(screen.getByText("Needs the transcription model")).toBeTruthy();
    expect(screen.getByText("1.6 GB")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Get the transcription model" }),
    );
    expect(onGet).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("offers Manage only when given a way to open the Models sheet", async () => {
    const onManage = vi.fn();
    view({ onManage });
    await userEvent.click(
      screen.getByRole("button", { name: "Manage models" }),
    );
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("follows the download in bytes with a Cancel", async () => {
    const { onCancel } = view({
      state: { kind: "downloading", bytes: 420_000_000, total: 1_600_000_000 },
    });
    expect(screen.getByText("420 MB of 1.6 GB")).toBeTruthy();
    const bar = screen.getByRole("progressbar", {
      name: "Getting the transcription model",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("26");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Cancel the transcription model download",
      }),
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps a progressbar and a spoken failure in the sheet row", () => {
    const { rerender } = render(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{
          kind: "downloading",
          bytes: 420_000_000,
          total: 1_600_000_000,
        }}
        onGet={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", {
      name: "Getting Transcription",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "26");
    expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
    rerender(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{ kind: "downloading", bytes: 420_000_000, total: null }}
        onGet={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("progressbar", { name: "Getting Transcription" }),
    ).not.toHaveAttribute("aria-valuenow");
    rerender(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{
          kind: "failed",
          failure: { kind: "network", plain: "Couldn't reach the server." },
        }}
        onGet={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't get Transcription. Couldn't reach the server.",
    );
  });

  it("shows a plain failure with Try again and no raw text", async () => {
    const { onGet } = view({
      state: {
        kind: "failed",
        failure: { kind: "network", plain: "Couldn't reach the server." },
      },
    });
    expect(
      screen.getByText("Couldn't get the transcription model"),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Try getting the transcription model again",
      }),
    );
    expect(onGet).toHaveBeenCalledOnce();
  });

  it("explains a blocked Get when another download holds the slot", () => {
    view({ blockedReason: "Another download is running" });
    const get = screen.getByRole("button", {
      name: "Get the transcription model",
    });
    expect((get as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Another download is running")).toBeTruthy();
  });

  it("calls an out-of-date model an update", () => {
    view({ state: { kind: "update_needed" } });
    expect(
      screen.getByRole("button", { name: "Update the transcription model" }),
    ).toBeTruthy();
  });
});

describe("ModelNeedRowView, list placement", () => {
  const meta = (state: ModelState) => {
    const { unmount } = view({
      placement: "list",
      model: { ...WHISPER, size: "~360 MB" },
      state,
    });
    const text = document.querySelector(".sys-need-meta")?.textContent;
    unmount();
    return text;
  };

  it("writes size and state in the meta line", () => {
    expect(meta({ kind: "missing" })).toBe("Not installed · 360 MB");
    expect(meta({ kind: "installed" })).toBe("Installed · 360 MB");
    expect(meta({ kind: "update_needed" })).toBe("Update available · 360 MB");
  });

  it("names the capability by what it does", () => {
    view({ placement: "list" });
    expect(screen.getByText("Transcription")).toBeTruthy();
  });

  it("has Get when missing, a ring with cancel while it runs, and nothing once installed", async () => {
    const { onGet, onCancel, rerender } = view({ placement: "list" });
    await userEvent.click(
      screen.getByRole("button", { name: "Get Transcription" }),
    );
    expect(onGet).toHaveBeenCalledOnce();
    rerender(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{ kind: "downloading", bytes: 1, total: 4 }}
        onGet={onGet}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel Transcription download" }),
    );
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{ kind: "installed" }}
        onGet={onGet}
        onCancel={onCancel}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps focus inside the row when Get gives way to Cancel", async () => {
    const onGet = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{ kind: "missing" }}
        onGet={onGet}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Get Transcription" }),
    );
    rerender(
      <ModelNeedRowView
        placement="list"
        model={WHISPER}
        state={{ kind: "downloading", bytes: 1, total: 4 }}
        onGet={onGet}
        onCancel={onCancel}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel Transcription download" }),
    );
  });
});

describe("ModelNeedRowView, Remove in the sheet row", () => {
  const SIZED = { ...WHISPER, id: "word-aligner", label: "Word aligner" };

  it("offers Remove in a more menu for an installed model and for one that needs an update", async () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <ModelNeedRowView
        placement="list"
        model={SIZED}
        state={{ kind: "installed" }}
        onGet={vi.fn()}
        onCancel={vi.fn()}
        onRemove={onRemove}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for Word timing" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove Word timing" }),
    );
    expect(onRemove).toHaveBeenCalledOnce();
    rerender(
      <ModelNeedRowView
        placement="list"
        model={SIZED}
        state={{ kind: "update_needed" }}
        onGet={vi.fn()}
        onCancel={vi.fn()}
        onRemove={onRemove}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Update Word timing" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "More for Word timing" }),
    ).toBeVisible();
    rerender(
      <ModelNeedRowView
        placement="list"
        model={SIZED}
        state={{ kind: "missing" }}
        onGet={vi.fn()}
        onCancel={vi.fn()}
        onRemove={onRemove}
      />,
    );
    expect(screen.queryByRole("button", { name: /^More for/ })).toBeNull();
  });
});

describe("ModelNeedRow with a models provider", () => {
  function mount(
    model: Parameters<typeof ModelNeedRow>[0]["model"],
    rows = registryRows(),
    placement: "need" | "list" = "need",
  ) {
    const api = modelsApi({ status: modelStatus(rows) });
    const out = render(<ModelNeedRow model={model} placement={placement} />, {
      wrapper: modelsWrapper(api),
    });
    return { api, ...out };
  }

  it("downloads the exact Whisper size the step asked for", async () => {
    const { api } = mount({ ...WHISPER, variant: "small.en", size: "~500 MB" });
    await userEvent.click(
      screen.getByRole("button", { name: "Get the transcription model" }),
    );
    expect(api.download).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "small.en",
    });
  });

  it("opens the Models sheet from Manage for a host, and offers no Manage to a guest", async () => {
    useDawStore.setState({ projectPath: "/tmp/p.json" });
    const { unmount } = mount(WHISPER);
    await userEvent.click(
      screen.getByRole("button", { name: "Manage models" }),
    );
    expect(runPointerCommand).toHaveBeenCalledWith("models.open");
    unmount();
    useDawStore.setState({ projectPath: "share:abc" });
    mount(WHISPER);
    expect(screen.queryByRole("button", { name: "Manage models" })).toBeNull();
    useDawStore.setState({ projectPath: "/tmp/p.json" });
  });

  it("removes an installed model from the sheet row after a confirm", async () => {
    const { asked } = answerQuestions(true);
    const rows = registryRows().map((r) =>
      r.id === "rnnoise" ? { ...r, state: "installed" as const } : r,
    );
    const { api } = mount(
      { id: "rnnoise", variant: null, label: "RNNoise", size: "~0.3 MB" },
      rows,
      "list",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for Noise reduction" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove Noise reduction" }),
    );
    await waitFor(() =>
      expect(api.remove).toHaveBeenCalledWith("rnnoise", null),
    );
    expect(asked[0]).toMatchObject({ title: "Remove Noise reduction?" });
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Noise reduction removed.",
      ),
    );
  });

  it("keeps the model when the confirm is declined", async () => {
    answerQuestions(null);
    const rows = registryRows().map((r) =>
      r.id === "rnnoise" ? { ...r, state: "installed" as const } : r,
    );
    const { api } = mount(
      { id: "rnnoise", variant: null, label: "RNNoise", size: "~0.3 MB" },
      rows,
      "list",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "More for Noise reduction" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove Noise reduction" }),
    );
    await act(async () => undefined);
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("calls onGet as the download starts", async () => {
    const onGet = vi.fn();
    const api = modelsApi({ status: modelStatus(registryRows()) });
    render(<ModelNeedRow model={WHISPER} onGet={onGet} />, {
      wrapper: modelsWrapper(api),
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Get the transcription model" }),
    );
    expect(onGet).toHaveBeenCalledOnce();
    expect(api.download).toHaveBeenCalledOnce();
  });

  it("renders nothing once the model is installed", () => {
    const rows = registryRows().map((r) =>
      r.id === "rnnoise" ? { ...r, state: "installed" as const } : r,
    );
    const { container } = mount(
      { id: "rnnoise", variant: null, label: "RNNoise", size: "~0.3 MB" },
      rows,
    );
    expect(container.textContent).toBe("");
  });

  it("blocks Get while a different download holds the slot", () => {
    const { container } = render(<ModelNeedRow model={WHISPER} />, {
      wrapper: modelsWrapper(
        modelsApi({
          status: modelStatus(registryRows()),
          job: {
            id: "j",
            status: "running",
            components: ["rnnoise"],
            whisper_model: "large-v3-turbo",
            download: null,
            error: null,
          } as never,
        }),
      ),
    });
    expect(
      within(container).getByText("Another download is running"),
    ).toBeTruthy();
  });
});
