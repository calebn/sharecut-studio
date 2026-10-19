import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type BleedAttenuationInspection,
  bleedAttenuationRegionKey,
} from "../../edit/bleedAttenuation";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  BleedAttenuationInspector,
  type BleedAttenuationInspectorProps,
} from "./BleedAttenuationInspector";

type Target = Readonly<{ seal: string; source: readonly number[] }>;

const target: Target = Object.freeze({
  seal: "backend-only",
  source: [20, 21],
});
const secondTarget: Target = Object.freeze({
  seal: "other-copy",
  source: [20, 21],
});
const inspection: BleedAttenuationInspection<typeof target> = {
  clipLabel: "Mira clip, 5 to 8 seconds",
  planState: "ready",
  planReasons: [],
  artifactState: "stale",
  restoreState: "none",
  savedSourceSpans: [],
  regions: [
    {
      trackId: "mira",
      occurrenceId: "clip-one",
      kind: "late_gate",
      sourceSpan: { start: 20, end: 21 },
      timelineSpan: { start: 5, end: 6 },
      restore: {
        state: "available",
        target,
        sourceSpan: { start: 20.5, end: 21 },
      },
    },
    {
      trackId: "mira",
      occurrenceId: "clip-two",
      kind: "bleed_mute:off_speaker",
      sourceSpan: { start: 20, end: 21 },
      timelineSpan: { start: 7, end: 8 },
      restore: {
        state: "available",
        target: secondTarget,
        sourceSpan: { start: 20, end: 21 },
      },
    },
  ],
};

function props(
  overrides: Partial<
    BleedAttenuationInspectorProps<typeof target, { head: string }>
  > = {},
): BleedAttenuationInspectorProps<typeof target, { head: string }> {
  return {
    read: { state: "ready", inspection },
    selectedKey: bleedAttenuationRegionKey(inspection.regions[0]),
    onSelect: vi.fn(),
    access: "host",
    canRestore: true,
    action: { state: "idle" },
    onRestore: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

describe("BleedAttenuationInspector", () => {
  it("submits only the selected opaque target once and shows its actionable source interval", async () => {
    const p = props();
    render(<BleedAttenuationInspector {...p} />);
    expect(screen.getByText("20.500 to 21.000 s")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Restore original audio" }),
    );
    expect(p.onRestore).toHaveBeenCalledTimes(1);
    expect(p.onRestore).toHaveBeenCalledWith(target);
    expect(vi.mocked(p.onRestore).mock.calls[0][0]).toBe(target);
    expect(p.onRestore).not.toHaveBeenCalledWith(secondTarget);
  });

  it("keeps selection controlled and supports Enter and Space", async () => {
    const p = props({ selectedKey: null });
    render(<BleedAttenuationInspector {...p} />);
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toBeDisabled();
    const second = screen.getByRole("button", {
      name: /^Automatic speaker mute,/,
    });
    second.focus();
    await userEvent.keyboard("{Enter} ");
    expect(p.onSelect).toHaveBeenCalledTimes(2);
    expect(p.onSelect).toHaveBeenLastCalledWith(
      bleedAttenuationRegionKey(inspection.regions[1]),
    );
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(p.onRestore).not.toHaveBeenCalled();
  });

  it("shows no host action to a guest even if a caller passes canRestore", () => {
    render(
      <BleedAttenuationInspector
        {...props({
          access: "guest",
          undo: { receipt: { head: "latest" }, onUndo: vi.fn() },
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Restore original audio" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Undo Restore" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh regions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Only the project host can restore this audio."),
    ).toBeVisible();
  });

  it("explains host permission and busy gates and never submits while blocked", async () => {
    const p = props({
      canRestore: false,
      permissionReason: "Open this project as its host to restore audio.",
    });
    const view = render(<BleedAttenuationInspector {...p} />);
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toHaveAccessibleDescription(p.permissionReason);
    await userEvent.click(
      screen.getByRole("button", { name: "Restore original audio" }),
    );
    expect(p.onRestore).not.toHaveBeenCalled();
    view.rerender(
      <BleedAttenuationInspector
        {...p}
        canRestore
        action={{ state: "saving", elapsedSeconds: 3 }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving Restore choice… 3 s elapsed.",
    );
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("requires an actual refresh after STALE_TARGET and passes the guarded Undo receipt unchanged", async () => {
    const receipt = Object.freeze({ head: "saved-head" });
    const onUndo = vi.fn();
    const p = props({
      action: {
        state: "error",
        code: "STALE_TARGET",
        message: "This clip changed. Nothing was saved.",
      },
      undo: { receipt, onUndo },
    });
    render(<BleedAttenuationInspector {...p} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was saved.");
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh regions" }),
    );
    expect(p.onRefresh).toHaveBeenCalledOnce();
    expect(p.onRestore).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Undo Restore" }));
    expect(onUndo).toHaveBeenCalledWith(receipt);
    expect(onUndo.mock.calls[0][0]).toBe(receipt);
  });

  it.each(["disabled", "unavailable_evidence"] as const)(
    "keeps authored mutes actionable when the late plan is %s",
    async (planState) => {
      const p = props({
        read: {
          state: "ready",
          inspection: {
            ...inspection,
            planState,
            planReasons: ["Check the recording and refresh regions."],
          },
        },
        selectedKey: bleedAttenuationRegionKey(inspection.regions[1]),
      });
      render(<BleedAttenuationInspector {...p} />);
      await userEvent.click(
        screen.getByRole("button", { name: "Restore original audio" }),
      );
      expect(p.onRestore).toHaveBeenCalledWith(secondTarget);
      expect(
        screen.getByText("Check the recording and refresh regions."),
      ).toBeVisible();
    },
  );

  it("shows saved coverage and render pending until the artifact is current", () => {
    const restored = {
      ...inspection,
      restoreState: "current" as const,
      savedSourceSpans: [{ start: 20, end: 20.5 }],
    };
    const p = props({ read: { state: "ready", inspection: restored } });
    const view = render(<BleedAttenuationInspector {...p} />);
    expect(
      screen.getByText("Restore choice saved for this recording."),
    ).toBeVisible();
    expect(screen.getByText("20.000 to 20.500 s")).toBeVisible();
    expect(
      screen.getByText(/Saved choices are pending in the next render/),
    ).toBeVisible();
    view.rerender(
      <BleedAttenuationInspector
        {...p}
        read={{
          state: "ready",
          inspection: { ...restored, artifactState: "current" },
        }}
      />,
    );
    expect(screen.getByText("Rendered audio is current.")).toBeVisible();
    expect(
      screen.queryByText(/Saved choices are pending/),
    ).not.toBeInTheDocument();
  });

  it.each(["changed_content", "unverified"] as const)(
    "keeps %s saved choices distinct from current rendered audio",
    (restoreState) => {
      render(
        <BleedAttenuationInspector
          {...props({
            read: {
              state: "ready",
              inspection: {
                ...inspection,
                restoreState,
                artifactState: "current",
              },
            },
          })}
        />,
      );
      expect(screen.getByText("Rendered audio is current.")).toBeVisible();
      expect(screen.getByText(/Refresh regions to/)).toBeVisible();
    },
  );

  it("offers refresh through loading, failed load, and an empty valid plan", async () => {
    const p = props({ read: { state: "loading" } });
    const view = render(<BleedAttenuationInspector {...p} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking automatic regions…",
    );
    expect(
      screen.getByRole("button", { name: "Refresh regions" }),
    ).toBeDisabled();
    view.rerender(
      <BleedAttenuationInspector
        {...p}
        read={{
          state: "error",
          message: "Could not check this recording. Try refreshing regions.",
        }}
      />,
    );
    expect(screen.getByText(/Could not check this recording/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh regions" }),
    );
    expect(p.onRefresh).toHaveBeenCalledOnce();
    view.rerender(
      <BleedAttenuationInspector
        {...p}
        read={{
          state: "ready",
          inspection: { ...inspection, regions: [], artifactState: "missing" },
        }}
      />,
    );
    expect(screen.getByText(/No automatic regions in this clip/)).toBeVisible();
    expect(screen.getByText(/No rendered audio yet/)).toBeVisible();
  });

  it("gives saved and unavailable intervals a visible disabled reason", () => {
    const p = props();
    const view = render(
      <BleedAttenuationInspector
        {...p}
        read={{
          state: "ready",
          inspection: {
            ...inspection,
            regions: [
              { ...inspection.regions[0], restore: { state: "saved" } },
            ],
          },
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toHaveAccessibleDescription(
      "A Restore choice already covers this interval.",
    );
    view.rerender(
      <BleedAttenuationInspector
        {...p}
        read={{
          state: "ready",
          inspection: {
            ...inspection,
            regions: [
              {
                ...inspection.regions[0],
                restore: {
                  state: "unavailable",
                  reason:
                    "The recording is missing. Restore it and refresh regions.",
                },
              },
            ],
          },
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toHaveAccessibleDescription(
      "The recording is missing. Restore it and refresh regions.",
    );
  });

  it("uses the shared accessibility check", async () => {
    const { container } = render(<BleedAttenuationInspector {...props()} />);
    await expectNoA11yViolations(container);
  });
});
