import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { ViewSheet } from "./ViewSheet";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/view/p.json", minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    guestMode: null,
    zoomPxPerSec: 100,
    waveformScale: "auto",
    laneHeightMode: "fixed",
  });
});

describe("ViewSheet", () => {
  it("holds what the old View menu held, as sheet sections", () => {
    render(<ViewSheet />);
    for (const name of [
      "Layers",
      "Waveform scale",
      "Waveform amplitude",
      "Track height",
      "Zoom",
    ]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("toggles a layer in the store", async () => {
    const user = userEvent.setup();
    render(<ViewSheet />);
    const layers = screen.getByRole("region", { name: "Layers" });
    const markers = within(layers).getByRole("checkbox", { name: /Markers/ });
    const before = useDawStore.getState().layers.showMarkers;
    await user.click(markers);
    expect(useDawStore.getState().layers.showMarkers).toBe(!before);
  });

  it("sets the waveform scale and shows which is on", async () => {
    const user = userEvent.setup();
    render(<ViewSheet />);
    const log = screen.getByRole("button", { name: "Log (dB)" });
    await user.click(log);
    expect(useDawStore.getState().waveformScale).toBe("log");
    expect(log).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("nudges waveform amplitude through the waveform commands", async () => {
    const user = userEvent.setup();
    render(<ViewSheet />);
    const before = useDawStore.getState().waveformAmpZoom;
    const amp = screen.getByRole("region", { name: "Waveform amplitude" });
    await user.click(within(amp).getAllByRole("button")[1]);
    expect(useDawStore.getState().waveformAmpZoom).not.toBe(before);
  });

  it("changes track height and fits tracks to the window", async () => {
    const user = userEvent.setup();
    render(<ViewSheet />);
    const heights = screen.getByRole("region", { name: "Track height" });
    await user.click(within(heights).getByRole("checkbox"));
    expect(useDawStore.getState().laneHeightMode).toBe("fit");
    await user.click(within(heights).getAllByRole("button")[1]);
    expect(useDawStore.getState().laneHeightMode).toBe("fixed");
  });

  it("zooms and fits the session", async () => {
    const user = userEvent.setup();
    render(<ViewSheet />);
    const zoom = screen.getByRole("region", { name: "Zoom" });
    await user.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    expect(useDawStore.getState().zoomPxPerSec).toBeGreaterThan(100);
    useDawStore.setState({ userZoomed: true });
    await user.click(
      within(zoom).getByRole("button", { name: /Fit session width/ }),
    );
    expect(useDawStore.getState().userZoomed).toBe(false);
  });
});
