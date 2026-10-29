import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

type Reset = Record<string, unknown>;

const ALWAYS: Reset = {
  envelopeDraft: null,
  wordDraft: null,
  heldTrim: null,
  transcriptInlineEditRequest: null,
  ingestBusy: false,
  ingestFileCount: 0,
  ingestDropTrackId: null,
};

const KEPT_ON_SAME_PATH: Reset = {
  sessionRosterVersion: 0,
  followingClientId: null,
  localClientId: null,
  followDegraded: {},
  transcriptTimingRequest: null,
  transcriptScrollRequest: null,
  transcriptReviewCursor: null,
  transcriptViewAnchor: null,
  playbackRate: 1,
};

const RESET_ON_SWITCH: Reset = {
  sourcePreview: null,
  sourcePreviewPositionSec: null,
  sourcePreviewError: null,
  audioError: null,
  isPlaying: false,
  playheadSec: 0,
  playStartSec: null,
  viewerMute: {},
  soloTracks: {},
  sessionRegion: null,
  lastAgentQuery: null,
  lastAppliedRevision: 0,
  lastAppliedCommandId: null,
  lastAppliedAgentSelectionSeq: 0,
  playUntilSec: null,
  highlightStaleRender: false,
  renderPreviewBusy: false,
  chapterAddPending: false,
  openJoinId: null,
  joinMutationInFlight: false,
  joinDraft: null,
  rippleTrim: null,
  rangeArmed: false,
  rangeScopeTrackIds: null,
  rangeBusy: false,
  bounceRangeTarget: null,
  prepareFocusTrackId: null,
  selection: null,
  pendingJobResults: {},
  spokenJobResultIds: [],
  envelopeSaving: [],
  feedbackToast: null,
  stage: "edit",
  stageViews: {},
  openSheet: null,
  landingSettled: false,
};

const SENTINEL = { sentinel: true };

function dirty(reset: Reset): Reset {
  return Object.fromEntries(Object.keys(reset).map((key) => [key, SENTINEL]));
}

function pick(keys: string[]): Reset {
  const state = useDawStore.getState() as unknown as Reset;
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

describe("hydrate resets", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      ...dirty(ALWAYS),
      ...dirty(KEPT_ON_SAME_PATH),
      ...dirty(RESET_ON_SWITCH),
      sessionClients: SENTINEL as never,
    } as never);
  });

  it("resets the always-reset fields on a same-path refresh", () => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    expect(pick(Object.keys(ALWAYS))).toEqual(ALWAYS);
  });

  it("keeps the path-bound and project-session fields on a same-path refresh", () => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    expect(pick(Object.keys(KEPT_ON_SAME_PATH))).toEqual(
      dirty(KEPT_ON_SAME_PATH),
    );
    expect(pick(Object.keys(RESET_ON_SWITCH))).toEqual(dirty(RESET_ON_SWITCH));
    expect(useDawStore.getState().sessionClients).toBe(SENTINEL);
  });

  it("resets the always-reset fields on a project switch", () => {
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    expect(pick(Object.keys(ALWAYS))).toEqual(ALWAYS);
  });

  it("resets the path-bound fields on a project switch", () => {
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    expect(pick(Object.keys(KEPT_ON_SAME_PATH))).toEqual(KEPT_ON_SAME_PATH);
    expect(useDawStore.getState().sessionClients).toBe(
      useDawStore.getInitialState().sessionClients,
    );
  });

  it("resets the session fields on a project switch", () => {
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    expect(pick(Object.keys(RESET_ON_SWITCH))).toEqual(RESET_ON_SWITCH);
  });

  it("resets the three project-bound chrome flags only on a project switch", () => {
    const flags = {
      bounceRequested: true,
      exportRequested: true,
      transcriptFindReplaceOpen: true,
    };
    const other = { shareDialogOpen: true };
    useDawStore.setState({
      chrome: { ...useDawStore.getState().chrome, ...flags, ...other },
    });
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    expect(useDawStore.getState().chrome).toMatchObject({ ...flags, ...other });
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    expect(useDawStore.getState().chrome).toMatchObject({
      bounceRequested: false,
      exportRequested: false,
      transcriptFindReplaceOpen: false,
      ...other,
    });
  });

  it("starts the store with the same values hydrate resets to", () => {
    const initial = useDawStore.getInitialState() as unknown as Reset;
    for (const reset of [ALWAYS, KEPT_ON_SAME_PATH, RESET_ON_SWITCH]) {
      for (const [key, value] of Object.entries(reset)) {
        expect({ key, value: initial[key] }).toEqual({ key, value });
      }
    }
  });
});
