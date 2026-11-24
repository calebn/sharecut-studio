import { beforeEach, describe, expect, it } from "vitest";
import { clipBleedDisabledReason } from "../commands/clipBleed";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import { canPlaceClips } from "../edit/clipPlacement";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const PATH = "/tmp/pin.project.json";

function shortProject(name: string) {
  return minimalProject({
    meta: { name },
    tracks: [sampleTrack()],
    timeline_duration_sec: 2,
  } as never);
}

beforeEach(() => {
  resetDocumentAuthority(PATH);
  useDawStore.getState().hydrate(PATH, minimalProject());
});

describe("projectEditBasis with no trim layer", () => {
  it("returns the displayed project by identity", () => {
    const project = minimalProject();
    useDawStore.getState().setProject(project);
    expect(useDawStore.getState().projectEditBasis()).toBe(project);
  });

  it("returns null while no project is open", () => {
    useDawStore.setState({ project: null });
    expect(useDawStore.getState().projectEditBasis()).toBeNull();
  });

  it("follows each published project and ignores a different document authority", () => {
    const authority = minimalProject({ meta: { name: "authority" } } as never);
    documentAuthority.project = authority;
    const first = shortProject("first");
    const second = shortProject("second");
    useDawStore.getState().setProject(first);
    expect(useDawStore.getState().projectEditBasis()).toBe(first);
    useDawStore.getState().setProject(second);
    expect(useDawStore.getState().projectEditBasis()).toBe(second);
  });
});

describe("setProject", () => {
  it("publishes nothing for the project already shown", () => {
    const project = shortProject("same");
    useDawStore.getState().setProject(project);
    const before = useDawStore.getState();
    let notified = 0;
    const stop = useDawStore.subscribe(() => {
      notified += 1;
    });
    useDawStore.getState().setProject(project);
    stop();
    expect(notified).toBe(0);
    expect(useDawStore.getState()).toBe(before);
  });

  it("publishes a new project in one notification", () => {
    const next = shortProject("next");
    const seen: unknown[] = [];
    const stop = useDawStore.subscribe((state) => seen.push(state.project));
    useDawStore.getState().setProject(next);
    stop();
    expect(seen).toEqual([next]);
  });

  it("reclamps a zoom the new project cannot show", () => {
    useDawStore.setState({ zoomPxPerSec: 1_000_000 });
    const before = useDawStore.getState().zoomPxPerSec;
    useDawStore.getState().setProject(shortProject("short"));
    const after = useDawStore.getState().zoomPxPerSec;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it("leaves the zoom alone when it already fits", () => {
    const zoom = useDawStore.getState().zoomPxPerSec;
    useDawStore.getState().setProject(shortProject("fits"));
    expect(useDawStore.getState().zoomPxPerSec).toBe(zoom);
  });
});

describe("hydrate", () => {
  it("shows the project, bumps the epoch on a switch and keeps it on a refresh", () => {
    const epoch = useDawStore.getState().projectEpoch;
    const refreshed = shortProject("refreshed");
    useDawStore.getState().hydrate(PATH, refreshed);
    expect(useDawStore.getState().project).toBe(refreshed);
    expect(useDawStore.getState().projectEditBasis()).toBe(refreshed);
    expect(useDawStore.getState().projectEpoch).toBe(epoch);
    const other = shortProject("other");
    useDawStore.getState().hydrate("/tmp/other.project.json", other);
    expect(useDawStore.getState().projectEditBasis()).toBe(other);
    expect(useDawStore.getState().projectEpoch).toBe(epoch + 1);
  });
});

describe("edit guards on an idle host project", () => {
  beforeEach(() => {
    useDawStore.setState({
      guestMode: null,
      shareCapabilities: null,
      joinMutationInFlight: false,
      rangeBusy: false,
      timelineDragging: false,
    });
  });

  it("allows clip placement and restoring audio", () => {
    expect(canPlaceClips(useDawStore.getState())).toBe(true);
    expect(clipBleedDisabledReason()).toBeUndefined();
  });

  it.each([
    ["joinMutationInFlight", "Wait for the join change to finish."],
    ["timelineDragging", "Finish the drag before restoring audio."],
  ] as const)("%s blocks both guards", (field, reason) => {
    useDawStore.setState({ [field]: true });
    expect(clipBleedDisabledReason()).toBe(reason);
    expect(canPlaceClips(useDawStore.getState())).toBe(false);
  });

  it("a busy range edit blocks restoring audio only", () => {
    useDawStore.setState({ rangeBusy: true });
    expect(clipBleedDisabledReason()).toBe(
      "Wait for the range edit to finish.",
    );
    expect(canPlaceClips(useDawStore.getState())).toBe(true);
  });
});
