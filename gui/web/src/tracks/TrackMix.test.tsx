import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { partial, rule } from "../test/cssRules";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TrackMix } from "./TrackMix";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));
const tracks = [
  sampleTrack({ id: "mira", label: "Mira voice", fader_db: -3, gain_db: -2 }),
  sampleTrack({ id: "music", label: "", role: "music", muted: true }),
];
function setup(
  guestMode: string | null = null,
  capabilities: string[] | null = null,
) {
  return render(
    <DawProvider
      projectPath={guestMode ? "share:fixture" : "/tmp/p.json"}
      initialProject={minimalProject({ tracks })}
      guestMode={guestMode}
      shareCapabilities={capabilities}
    >
      <TrackMix />
    </DawProvider>,
  );
}
describe("TrackMix", () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
    useDawStore.setState({ soloTracks: {}, viewerMute: {}, selection: null });
  });
  it("renders project order, fallback names, lane identity and saved volume", async () => {
    const view = setup();
    const rows = within(
      screen.getByRole("list", { name: "Track mix" }),
    ).getAllByRole("listitem");
    expect(
      rows.map((row) => row.querySelector(".track-mix-name")?.textContent),
    ).toEqual(["Mira voice", "music"]);
    expect(rows[0].querySelector(".track-mix-identity")).toHaveTextContent(
      "MV",
    );
    expect(rows[1]).toHaveStyle({
      "--track-identity-color": "var(--color-clip-music)",
    });
    expect(
      screen.getByRole("slider", { name: "Volume Mira voice" }),
    ).toHaveValue("-3");
    expect(screen.getByRole("button", { name: "Mute music" })).toHaveAttribute(
      "data-mute-state",
      "saved",
    );
    await expectNoA11yViolations(view.container);
  });
  it("targets row IDs without changing inspector selection", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Mute music" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Solo Mira voice" }),
    );
    fireEvent.input(screen.getByRole("slider", { name: "Volume Mira voice" }), {
      target: { value: "-6" },
    });
    expect(
      screen.getByRole("slider", { name: "Volume Mira voice" }),
    ).toHaveAttribute("aria-valuetext", "−6.0 dB");
    expect(execute).toHaveBeenCalledTimes(2);
    fireEvent.change(
      screen.getByRole("slider", { name: "Volume Mira voice" }),
      { target: { value: "-6" } },
    );
    expect(vi.mocked(execute).mock.calls).toEqual([
      ["track.muteToggle", { trackId: "music" }, { skipWhen: true }],
      ["track.soloToggle", { trackId: "mira" }, { skipWhen: true }],
      ["track.setVolume", { trackId: "mira", db: -6 }, { skipWhen: true }],
    ]);
    expect(useDawStore.getState().selection).toBeNull();
  });
  it.each(["view", "comment", "edit"])(
    "uses actual capabilities for %s volume access",
    async (guestMode) => {
      const view = setup(guestMode, ["view"]);
      const slider = screen.getByRole("slider", { name: "Volume Mira voice" });
      expect(slider).toBeDisabled();
      expect(slider).toHaveAccessibleDescription(
        /Only the host and editors can change volume/,
      );
      expect(
        screen.getByRole("button", { name: "Mute music" }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText(/Shared playback uses Full mix/)).toBeVisible();
      act(() => useDawStore.setState({ shareCapabilities: ["view", "edit"] }));
      expect(slider).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Mute music" }),
      ).not.toHaveAttribute("aria-disabled");
      fireEvent.change(slider, { target: { value: "-4" } });
      expect(execute).toHaveBeenCalledWith(
        "track.setVolume",
        { trackId: "mira", db: -4 },
        { skipWhen: true },
      );
      await expectNoA11yViolations(view.container);
    },
  );
  it("preserves saved, local listen and implied mute precedence", () => {
    setup("view", ["view"]);
    act(() =>
      useDawStore.setState({
        soloTracks: { music: true },
        viewerMute: { music: true },
      }),
    );
    expect(screen.getByRole("button", { name: "Mute music" })).toHaveAttribute(
      "data-mute-state",
      "saved",
    );
    expect(
      screen.getByRole("button", { name: "Mute Mira voice" }),
    ).toHaveAttribute("data-mute-state", "implied");
    act(() => useDawStore.setState({ viewerMute: { mira: true } }));
    expect(
      screen.getByRole("button", { name: "Mute Mira voice" }),
    ).toHaveAttribute("data-mute-state", "listen");
    expect(screen.getByRole("button", { name: "Solo music" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("moves focus to the soloed track's S button when the Mix chip is activated", async () => {
    setup();
    act(() => useDawStore.setState({ soloTracks: { music: true } }));
    const chip = screen.getByRole("button", { name: "Solo on · Clear solo" });
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(execute).toHaveBeenCalledWith(
      "track.clearSolo",
      {},
      { skipWhen: true },
    );
    expect(screen.getByRole("button", { name: "Solo music" })).toHaveFocus();
  });
  it("dims rows nobody hears, dashes only-you rows, and offers Clear solo", async () => {
    const view = setup();
    const rowClasses = () =>
      within(screen.getByRole("list", { name: "Track mix" }))
        .getAllByRole("listitem")
        .map((row) => row.className);
    expect(rowClasses()).toEqual(["track-mix-row", "track-mix-row muted"]);
    expect(screen.queryByRole("button", { name: /Clear solo/ })).toBeNull();

    act(() => useDawStore.setState({ soloTracks: { music: true } }));
    expect(rowClasses()).toEqual([
      "track-mix-row mute-implied",
      "track-mix-row muted",
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Solo on · Clear solo" }),
    );
    expect(execute).toHaveBeenCalledWith(
      "track.clearSolo",
      {},
      { skipWhen: true },
    );
    const css = partial("track-mix.css");
    expect(rule(css, ".track-mix-row:is(.muted, .mute-implied)")).toMatch(
      /background:\s*var\(--color-track-muted\)/,
    );
    const tile = rule(
      css,
      ".track-mix-row:is(.muted, .mute-implied) .track-mix-identity",
    );
    expect(tile).toMatch(/outline:\s*1px solid var\(--track-identity-color\)/);
    expect(tile).not.toMatch(/opacity:/);
    expect(
      rule(
        css,
        ".track-mix-row:is(.mute-listen, .mute-implied) .track-mix-identity",
      ).trim(),
    ).toBe("outline-style: dashed;");
    await expectNoA11yViolations(view.container);
  });
  it("distinguishes loading from an empty loaded project", async () => {
    useDawStore.getState().hydrate("/tmp/p.json", null);
    const view = render(<TrackMix />);
    expect(screen.getByLabelText("Loading tracks")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    act(() => useDawStore.getState().setProject(minimalProject()));
    expect(
      screen.getByText("No tracks yet. Add or import audio from More."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Loading tracks")).toBeNull();
    await expectNoA11yViolations(view.container);
  });
});
