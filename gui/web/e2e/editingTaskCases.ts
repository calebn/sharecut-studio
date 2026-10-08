import type {
  DurableState,
  TaskDefinition,
  TaskRoute,
} from "./editingTaskReport";

const clip = {
  track_id: "reference",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  source_id: null,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  mute_regions: [],
};
const trackInvariants = {
  label: "reference",
  speaker: "reference",
  room_tone: null,
  gate_fill: null,
  balance_basis: null,
  transcript_gate: false,
  transcript_gate_scope: null,
  proxy: null,
  timeline_empty: false,
};
const base: DurableState = {
  duration_sec: 20,
  sources: [
    {
      id: "reference_src0",
      path: "raw/reference.wav",
      speaker: "reference",
      label: "reference.wav",
      offset_sec: 0,
      duration_sec: null,
      sample_rate: null,
      channels: null,
      clipping_regions: [],
      clipping_truncated: false,
    },
    {
      id: "guest_src0",
      path: "raw/guest.wav",
      speaker: "guest",
      label: "guest.wav",
      offset_sec: 0,
      duration_sec: null,
      sample_rate: null,
      channels: null,
      clipping_regions: [],
      clipping_truncated: false,
    },
  ],
  stable: {
    chapters: [],
    speaker_splits: [],
    retained_bleed_alignments: [],
    processing_chains: [],
    social: { clip_candidates: [] },
    review_versions: [],
    active_version_id: null,
  },
  clips: [
    { ...clip, id: "first-copy" },
    { ...clip, id: "second-copy", timeline_start: 10 },
    { ...clip, id: "peer", track_id: "guest", source_end: 20 },
  ],
  tracks: [
    {
      id: "reference",
      fader_db: 0,
      gain_db: 0,
      muted: false,
      role: "dialogue",
      media: {
        path: "raw/reference.wav",
        duration_sec: 60,
        sample_rate: 48000,
        channels: 1,
      },
      invariants: trackInvariants,
    },
    {
      id: "guest",
      fader_db: 0,
      gain_db: 0,
      muted: false,
      role: "dialogue",
      media: {
        path: "raw/guest.wav",
        duration_sec: 60,
        sample_rate: 48000,
        channels: 1,
      },
      invariants: { ...trackInvariants, label: "guest", speaker: "guest" },
    },
  ],
  envelopes: [],
  comments: [],
};
function route(
  id: string,
  input: "pointer" | "keyboard" | "numeric" | "cdp-touch",
  command: string | null,
  cancel = false,
  undo: "history" | "comment-toast" | "none" = "history",
  mutations = 1,
): TaskRoute {
  return { id, input, command, cancel, undo, mutations };
}
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const envelopeStart: DurableState = {
  ...base,
  envelopes: [
    {
      track_id: "reference",
      parameter: "volume",
      points: [
        { id: "p1", time: 2, value: 0.6 },
        { id: "p2", time: 10, value: 1.4 },
      ],
    },
  ],
};
const commentStart: DurableState = {
  ...base,
  comments: [
    {
      id: "task-comment",
      body: "Editing task comment",
      author: "Host",
      timeline_start: 2,
      timeline_end: null,
      track_ids: [],
      resolved: false,
      resolved_by: null,
      review_version_id: null,
      edit_decision_id: null,
      timeline_spans: [],
      action_items: [],
      replies: [],
    },
  ],
};
export const editingTaskRegistry: TaskDefinition[] = [
  {
    id: "seek",
    family: "seek",
    viewport: desktop,
    start: base,
    expected: base,
    seek: 5,
    tolerances: {},
    routes: [
      route("ruler-pointer", "pointer", null, false, "none", 0),
      route("ruler-keyboard", "keyboard", null, false, "none", 0),
      {
        id: "timestamp",
        pending: "TimeRulerView has no exact timestamp entry",
      },
    ],
  },
  {
    id: "range-cut",
    historyLabels: {
      before: "before selected range",
      after: "after selected range",
    },
    historyOperation: "edit_selected_range",
    family: "range-cut",
    viewport: desktop,
    start: base,
    expected: {
      ...base,
      clips: [
        { ...clip, id: "first-copy" },
        {
          ...clip,
          id: "cut-left",
          source_end: 1,
          timeline_start: 10,
          fade_out_ms: 10,
        },
        {
          ...clip,
          id: "cut-right",
          source_start: 2,
          timeline_start: 12,
          fade_in_ms: 10,
        },
        base.clips[2],
      ],
    },
    tolerances: {},
    routes: [
      route("armed-pointer", "pointer", "EditSelectedRange", true),
      route("range-form", "numeric", "EditSelectedRange", true),
    ],
  },
  {
    id: "trim",
    historyLabels: {
      before: "before trim clip edge",
      after: "after trim clip edge",
    },
    historyOperation: "trim_clip_edge",
    family: "trim-fade",
    editMode: "ripple",
    viewport: desktop,
    start: base,
    expected: {
      ...base,
      duration_sec: 19.7,
      clips: [
        { ...base.clips[0], source_start: 0.3 },
        { ...base.clips[1], timeline_start: 9.7 },
        { ...base.clips[2], source_start: 0.3 },
      ],
    },
    tolerances: {
      "after.duration_sec": 0.03,
      "after.clips.first-copy.source_start": 0.03,
      "after.clips.second-copy.timeline_start": 0.03,
      "after.clips.peer.source_start": 0.03,
    },
    routes: [
      route("handle-pointer", "pointer", "TrimClipEdge", true),
      route("handle-keyboard", "keyboard", "TrimClipEdge", true),
      {
        id: "numeric-trim",
        pending: "ClipInspector Source is text; no numeric trim input",
      },
    ],
  },
  {
    id: "fade",
    historyLabels: {
      before: "before set clip fade",
      after: "after set clip fade",
    },
    historyOperation: "set_clip_fade",
    family: "trim-fade",
    viewport: desktop,
    start: base,
    expected: {
      ...base,
      clips: [
        { ...base.clips[0], fade_in_ms: 40 },
        base.clips[1],
        base.clips[2],
      ],
    },
    tolerances: { "after.clips.first-copy.fade_in_ms": 1 },
    routes: [
      route("corner-pointer", "pointer", "SetClipFade", true),
      route("inspector-slider", "keyboard", "SetClipFade", true),
    ],
  },
  {
    id: "envelope",
    historyLabels: {
      before: "before set envelope",
      after: "after set envelope reference",
    },
    historyOperation: null,
    family: "envelope",
    viewport: desktop,
    start: envelopeStart,
    expected: {
      ...base,
      envelopes: [
        {
          track_id: "reference",
          parameter: "volume",
          points: [
            { id: "p1", time: 6, value: 0.8 },
            { id: "p2", time: 10, value: 1.4 },
          ],
        },
      ],
    },
    tolerances: {
      "after.envelopes.0.points.0.time": 0.03,
      "after.envelopes.0.points.0.value": 0.02,
    },
    routes: [
      route("point-pointer", "pointer", "SetEnvelope", true),
      route("point-form", "numeric", "SetEnvelope", true),
      route("point-form-tab-header", "numeric", "SetEnvelope", true),
    ],
  },
  {
    id: "reorder",
    historyLabels: {
      before: "before reorder track guest",
      after: "after reorder track guest",
    },
    historyOperation: "reorder_track",
    family: "reorder",
    viewport: desktop,
    start: base,
    expected: { ...base, tracks: [base.tracks[1], base.tracks[0]] },
    tolerances: {},
    routes: [
      route("html-drag", "pointer", "ReorderTrack", true),
      route("move-up", "pointer", "ReorderTrack"),
      route("move-up-tab-header", "pointer", "ReorderTrack"),
    ],
  },
  {
    id: "mix",
    historyLabels: {
      before: "before set track volume reference",
      after: "after set track volume reference",
    },
    historyOperation: "set_track_volume",
    family: "mix",
    viewport: phone,
    start: base,
    expected: {
      ...base,
      tracks: [{ ...base.tracks[0], fader_db: -6 }, base.tracks[1]],
    },
    tolerances: { "after.tracks.0.fader_db": 0.25 },
    routes: [
      route("native-pointer", "pointer", "SetTrackFader", true),
      route(
        "native-keyboard",
        "keyboard",
        "SetTrackFader",
        false,
        "history",
        12,
      ),
      {
        id: "precise-field",
        pending: "TrackMixView has no precise numeric field or stepper",
      },
    ],
  },
  {
    id: "comment",
    family: "comment",
    viewport: phone,
    start: commentStart,
    expected: {
      ...commentStart,
      comments: [
        { ...commentStart.comments[0], resolved: true, resolved_by: "Host" },
      ],
    },
    tolerances: {},
    routes: [
      route(
        "resolve-button",
        "pointer",
        "ResolveComment",
        false,
        "comment-toast",
      ),
      route(
        "trusted-touch-swipe",
        "cdp-touch",
        "ResolveComment",
        true,
        "comment-toast",
      ),
    ],
  },
];
