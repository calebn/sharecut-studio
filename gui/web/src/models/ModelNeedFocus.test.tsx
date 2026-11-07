import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BounceSection } from "../stages/deliver/BounceSection";
import { BOUNCE_DEFAULTS } from "../stages/deliver/bounceLogic";
import { SETTINGS } from "../stages/deliver/deliverFixture";
import { EpisodeFile } from "../stages/deliver/EpisodeFile";
import { modelStatus, modelsApi, registryRows } from "../test/renderWithModels";
import type { ModelState } from "./types";
import { type ModelsApi, ModelsContext } from "./useModels";

const MODEL = {
  id: "speaker-ecapa",
  variant: null,
  label: "Speaker model",
  purpose: "speaker recognition and split",
  size: "~25 MB",
  sizeBytes: null,
  state: "missing",
};

function api(state: ModelState): ModelsApi {
  const base = modelsApi({ status: modelStatus(registryRows()) });
  return {
    ...base,
    models:
      base.models?.map((row) =>
        row.id === MODEL.id ? { ...row, state } : row,
      ) ?? null,
  };
}

function tree(kind: "bounce" | "export", models: ModelsApi, loading = false) {
  return (
    <ModelsContext.Provider value={models}>
      <button type="button">Elsewhere</button>
      {kind === "bounce" ? (
        <BounceSection
          state={loading ? "loading" : "ready"}
          options={{
            choices: BOUNCE_DEFAULTS,
            state: { phase: "needs-model", model: MODEL },
            selectedCount: 0,
            soloCount: 0,
            hasRegion: false,
            onChoices: vi.fn(),
            onBounce: vi.fn(),
            onCancel: vi.fn(),
          }}
        />
      ) : (
        <EpisodeFile
          state={loading ? "loading" : "ready"}
          settings={SETTINGS}
          total={60}
          exportState={{ phase: "needs-model", model: MODEL }}
          hasTranscriptSection={false}
          onSettings={vi.fn()}
          onExport={vi.fn()}
        />
      )}
    </ModelsContext.Provider>
  );
}

const get = () => screen.getByRole("button", { name: "Get the speaker model" });

describe.each(["bounce", "export"] as const)("%s model-need focus", (kind) => {
  it("hands focus to Get when the pending status read first makes it available", async () => {
    const view = render(tree(kind, api({ kind: "checking" })));
    expect(
      screen.queryByRole("button", { name: "Get the speaker model" }),
    ).toBeNull();
    view.rerender(tree(kind, api({ kind: "missing" })));
    await waitFor(() => expect(get()).toHaveFocus());
  });

  it("hands focus to Try again when a pending read becomes unavailable", async () => {
    const view = render(tree(kind, api({ kind: "checking" })));
    view.rerender(tree(kind, api({ kind: "unavailable" })));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Check .* status$/ }),
      ).toHaveFocus(),
    );
  });

  it("handles the need panel mounting after the section finishes loading", async () => {
    const view = render(tree(kind, api({ kind: "checking" }), true));
    view.rerender(tree(kind, api({ kind: "missing" })));
    await waitFor(() => expect(get()).toHaveFocus());
  });

  it("respects a move to Manage while the primary action is still pending", async () => {
    const view = render(tree(kind, api({ kind: "checking" })));
    const manage = screen.getByRole("button", { name: "Manage models" });
    manage.focus();
    view.rerender(tree(kind, api({ kind: "missing" })));
    await waitFor(() => expect(get()).toBeVisible());
    expect(manage).toHaveFocus();
  });

  it.each(["pointer", "keyboard"])(
    "yields to %s navigation begun before the primary action appears",
    async (input) => {
      const view = render(tree(kind, api({ kind: "checking" })));
      if (input === "pointer") {
        fireEvent.pointerDown(
          screen.getByRole("button", { name: "Elsewhere" }),
        );
      } else {
        await userEvent.tab();
      }
      view.rerender(tree(kind, api({ kind: "missing" })));
      await waitFor(() => expect(get()).toBeVisible());
      expect(get()).not.toHaveFocus();
    },
  );

  it("leaves focus where the person moved while status was pending", async () => {
    const view = render(tree(kind, api({ kind: "checking" })));
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    view.rerender(tree(kind, api({ kind: "missing" })));
    await waitFor(() => expect(get()).toBeVisible());
    expect(elsewhere).toHaveFocus();
  });

  it("does not reclaim focus on later status updates after its first handoff", async () => {
    const view = render(tree(kind, api({ kind: "missing" })));
    expect(get()).toHaveFocus();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    view.rerender(tree(kind, api({ kind: "checking" })));
    view.rerender(tree(kind, api({ kind: "missing" })));
    await waitFor(() => expect(get()).toBeVisible());
    expect(elsewhere).toHaveFocus();
  });
});
