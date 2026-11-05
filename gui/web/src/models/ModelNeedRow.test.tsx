import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../test/renderWithModels";
import { ModelNeedRow, ModelNeedRowView } from "./ModelNeedRow";
import type { ModelState } from "./types";

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

describe("ModelNeedRow with a models provider", () => {
  function mount(
    model: Parameters<typeof ModelNeedRow>[0]["model"],
    rows = registryRows(),
  ) {
    const api = modelsApi({ status: modelStatus(rows) });
    const out = render(<ModelNeedRow model={model} />, {
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
