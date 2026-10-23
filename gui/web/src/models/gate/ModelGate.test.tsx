import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  type ModelsFixture,
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import { ModelsContext } from "../useModels";
import { ModelGateDialog, ModelGatePanel } from "./ModelGate";
import { useModelGate } from "./useModelGate";

const JOB = {
  id: "j1",
  kind: "bootstrap",
  status: "running",
  components: ["word-aligner"],
  whisper_model: "large-v3-turbo",
  download: {
    component: "word-aligner",
    bytes: 120_000_000,
    total: 360_000_000,
  },
} as never;

function Trigger({ panel = false }: { panel?: boolean }) {
  const gate = useModelGate();
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => void gate.run(async () => "x", [{ id: "word-aligner" }])}
      >
        Open
      </button>
      {panel ? <ModelGatePanel gate={gate} /> : <ModelGateDialog gate={gate} />}
    </>
  );
}

function mount(fixture: Partial<ModelsFixture> = {}, panel = false) {
  const api = modelsApi({ status: modelStatus(registryRows()), ...fixture });
  const view = render(
    <ModelsContext.Provider value={api}>
      <Trigger panel={panel} />
    </ModelsContext.Provider>,
  );
  return { api, ...view };
}

afterEach(() => useDawStore.getState().setModelsDialogOpen(false));

describe("ModelGate", () => {
  it("states the purpose, the size and where it is stored, with no axe violations", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Download Word aligner?",
    });
    expect(dialog).toHaveTextContent(
      "Precise word boundaries. About 360 MB, stored on this computer.",
    );
    await expectNoA11yViolations(dialog);
  });

  it("moves focus to Download and returns it to the trigger on Not now", async () => {
    mount();
    const open = screen.getByRole("button", { name: "Open" });
    await userEvent.click(open);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download" })).toHaveFocus(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(open).toHaveFocus());
  });

  it("treats Escape as Not now while idle", async () => {
    const { api } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.download).not.toHaveBeenCalled();
  });

  it("shows the real byte bar and ignores Escape while downloading", async () => {
    const download = vi.fn(() => new Promise<never>(() => undefined));
    const { api } = mount({ download });
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Download" }),
    );
    expect(
      await screen.findByRole("button", { name: "Cancel download" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel download" }),
    );
    expect(api.cancel).toHaveBeenCalled();
  });

  it("paints progress bytes from the controller", async () => {
    const { api } = mount({ job: JOB });
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "120 MB of 360 MB");
    expect(api.download).not.toHaveBeenCalled();
  });

  it("opens Models after the prompt closes on Manage models", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Manage models" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useDawStore.getState().chrome.modelsDialogOpen).toBe(true);
  });

  it("embeds in a host dialog without opening another dialog", async () => {
    mount({}, true);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const download = await screen.findByRole("button", { name: "Download" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      within(download.closest(".model-gate-panel") as HTMLElement).getByText(
        /stored on this computer/,
      ),
    ).toBeInTheDocument();
  });
});
