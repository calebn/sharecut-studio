export type SessionOrigin = "agent" | "viewer";
export type AuditionMode = "mix" | "fx" | "raw";

export interface SessionRegion {
  start_sec: number;
  end_sec: number;
}

export interface SessionSelection {
  kind: string;
  id?: string;
  track_id?: string;
  time?: number;
  word_index?: number | null;
  word_end?: number | null;
}

export interface PresenceCursor {
  t_sec?: number | null;
  track_id?: string | null;
  /** Fractional lane index from the top of the lane stack (e.g. 1.4 = 40% into lane 2). */
  lane_pos?: number | null;
  /** data-presence-anchor id when the pointer is outside the timeline lanes. */
  anchor?: string | null;
  x?: number | null;
  y?: number | null;
}

export type PresenceTab =
  | "transcript"
  | "history"
  | "impact"
  | "tighten"
  | "pipeline"
  | "comments";
export type PresenceMobileMode = "listen" | "timeline" | "text" | "more";

export interface PresenceUi {
  tab?: PresenceTab | null;
  mobile_mode?: PresenceMobileMode | null;
  transcript_anchor?: string | null;
  audition?: AuditionMode | null;
  viewer_mute?: string[];
  solo?: string[];
}

export interface PresenceViewport {
  start_sec: number;
  end_sec: number;
}

export interface PresenceTransport {
  playing: boolean;
  playhead_sec: number;
  rate: number;
  stamped_ns?: number;
}

export interface PresenceMeta {
  display_name?: string | null;
  color_index?: number;
  cursor?: PresenceCursor | null;
  selection?: SessionSelection | null;
  viewport?: PresenceViewport | null;
  transport?: PresenceTransport | null;
  following?: string | null;
  ui?: PresenceUi | null;
}

export interface SessionClient {
  client_id: string;
  role: string;
  label?: string | null;
  playhead_sec?: number | null;
  last_seen_ns?: number;
  followers?: number;
  meta?: PresenceMeta | null;
}

export interface SessionState {
  version: number;
  revision: number;
  server_seq?: number;
  origin: SessionOrigin;
  last_role?: string | null;
  last_client_id?: string | null;
  updated_at_ns: number;
  command_id: string | null;
  playhead_sec: number;
  is_playing: boolean;
  audition_mode: AuditionMode;
  region: SessionRegion | null;
  source: string | null;
  track_id: string | null;
  query: string | null;
  match_index: number | null;
  selection: SessionSelection | null;
  viewer_mute: Record<string, boolean>;
  solo_tracks: Record<string, boolean>;
  tier: string | null;
  dry_run: boolean;
  wav?: string | null;
  compare_segments?: unknown[] | null;
  clients?: SessionClient[];
  server_time_ns?: number;
}

export interface SessionMeta {
  path: string;
  mtime_ns: number;
  size: number;
  exists: boolean;
}

export type ViewerSessionSnapshot = Partial<{
  playhead_sec: number;
  is_playing: boolean;
  audition_mode: AuditionMode;
  region: SessionRegion | null;
  source: string | null;
  track_id: string | null;
  query: string | null;
  match_index: number | null;
  selection: SessionSelection | null;
  viewer_mute: Record<string, boolean>;
  solo_tracks: Record<string, boolean>;
  tier: string | null;
  dry_run: boolean;
  /** Ack the agent command so viewer POSTs may overwrite transport fields. */
  ack_command_id: string | null;
  client_id?: string;
  label?: string;
}>;
