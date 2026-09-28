/** `GET /api/project/prosody` (edits/prosody_profile.py::prosody_overlay, #719). */
export type ProsodyStatus = "fresh" | "stale" | "missing" | "unavailable";

export interface ProsodyTimelineSpan {
  start: number;
  end: number;
}

export interface ProsodyEnergyThird {
  db: number;
  spans: ProsodyTimelineSpan[];
}

export interface ProsodyOverlaySegment {
  source_start: number;
  source_end: number;
  spans: ProsodyTimelineSpan[];
  energy_thirds: ProsodyEnergyThird[];
  trend: "falling" | "rising" | "flat" | (string & {});
  drop_db: number;
  line: string;
}

export interface ProsodyBoundary {
  timeline_sec: number;
  strength: number;
  kind: "word_gap" | "segment_end" | (string & {});
  pause_sec: number;
}

export interface ProsodyProminentWord {
  text: string;
  score: number;
  word_index: number | null;
  timeline_sec: number | null;
}

export interface ProsodyOverlayTrack {
  track_id: string;
  status: ProsodyStatus;
  hint?: string;
  segments: ProsodyOverlaySegment[];
  boundaries: ProsodyBoundary[];
  prominent_words: ProsodyProminentWord[];
  energy_db: { min: number; max: number } | null;
}

export interface ProsodyOverlay {
  schema: string;
  tracks: ProsodyOverlayTrack[];
}
