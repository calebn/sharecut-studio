import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { TrackColumn } from "./TrackColumn";

const draws = vi.hoisted(() => new Map<string, number>());

vi.mock("../../system/TrackHeader", () => ({
  TrackHeader: (props: { id: string }) => {
    draws.set(props.id, (draws.get(props.id) ?? 0) + 1);
    return <div data-testid={props.id} />;
  },
}));

const PATH = "/tmp/p.json";
const IDS = ["a", "b", "c"];

function mount() {
  const initial = minimalProject({
    tracks: IDS.map((id) => sampleTrack({ id, label: id })),
  });
  useDawStore.getState().hydrate(PATH, initial);
  return render(
    <DawProvider projectPath={PATH} initialProject={initial}>
      <TrackColumn />
    </DawProvider>,
  );
}

const counts = () => IDS.map((id) => draws.get(id) ?? 0);

describe("TrackColumn draws", () => {
  beforeEach(() => {
    draws.clear();
    useDawStore.setState({ selection: null, soloTracks: {} });
  });

  it("redraws no header for a playhead frame", () => {
    mount();
    const before = counts();
    for (let t = 1; t <= 5; t += 1) {
      act(() => useDawStore.setState({ playheadSec: t }));
    }
    expect(counts()).toEqual(before);
  });

  it("redraws only the header whose track is selected, then the two whose selection changed", () => {
    mount();
    const first = counts();
    act(() => useDawStore.getState().toggleTrackSelected("b", false));
    const second = counts();
    expect(second.map((n, i) => n - first[i])).toEqual([0, 1, 0]);
    act(() => useDawStore.getState().toggleTrackSelected("c", false));
    expect(counts().map((n, i) => n - second[i])).toEqual([0, 1, 1]);
  });

  it("redraws a soloed header and the headers it silences, not a header whose mute does not change", () => {
    mount();
    const first = counts();
    act(() => useDawStore.getState().setSoloMap({ a: true }));
    // a is soloed, b and c are silenced by it.
    expect(counts().map((n, i) => n - first[i])).toEqual([1, 1, 1]);
    const second = counts();
    act(() => useDawStore.getState().setSoloMap({ a: true, b: true }));
    // Only b changes: no longer silenced, and soloed.
    expect(counts().map((n, i) => n - second[i])).toEqual([0, 1, 0]);
  });
});
