/**
 * The wire shape of the Podcast listing. The service resolves the feed and
 * sends this view; the CLI and MCP read and edit the same shape. The GUI
 * story is the only surface that speaks it today, and no service exists yet.
 * Every fact says where its value came from, so a surface can mark auto
 * values, flag a pin whose source changed, and name the fix for a missing one.
 * Button labels are not on the wire: `feedLogic` looks them up.
 */

export type FieldKey = string;
export type FieldValue = string | number | boolean | readonly string[];

/** The one edit vocabulary. A set with an empty value asks for input before it can run. */
export type FeedEdit =
  | { op: "set"; key: FieldKey; value: FieldValue }
  | { op: "unset"; key: FieldKey };

export type FeedCommand =
  | "export_episode"
  | "create_show"
  | "link_show"
  | "choose_art"
  | "write_feed";

export type Fix =
  | { kind: "edit"; edit: FeedEdit }
  | {
      kind: "command";
      command: FeedCommand;
      args?: Readonly<Record<string, string>>;
    };

export type Derived = { kind: "derived"; rule: string };
export type Inherited = { kind: "inherited"; from: FieldKey };
export type Measured = { kind: "measured"; file: string };
export type Minted = { kind: "minted"; at: string };
export type Pinned = {
  kind: "pinned";
  by: "person" | "agent";
  /** The auto value changed since the pin was made. */
  drifted: boolean;
};
export type Resolved = Derived | Inherited | Measured | Minted | Pinned;
export type Pending = { kind: "pending"; why: string; fix: Fix | null };

export type Known<T> = { value: T; source: Resolved };
export type Missing = { value: null; source: Pending };
export type Fact<T> = Known<T> | Missing;

export type Art = { src: string; alt: string };
export type FeedChapter = { at: number; title: string };
export type Credit = { name: string; role: string };
export type Transcript = { format: "SRT" | "VTT"; language: string };
export type Soundbite = { title: string; start: number; end: number };
export type AudioFile = { mime: string; bytes: number };

/** The facts that are not one scalar. Scalars live in `item` and `channel`. */
export type Sections = {
  art: Fact<Art>;
  audio: Fact<AudioFile>;
  chapters: Fact<readonly FeedChapter[]>;
  credits: Fact<readonly Credit[]>;
  transcripts: Fact<readonly Transcript[]>;
  soundbites: Fact<readonly Soundbite[]>;
};

export type ShowState =
  | { kind: "none"; suggest: { language: string; hosts: readonly Credit[] } }
  | { kind: "choose"; shows: readonly { id: string; title: string }[] }
  | { kind: "ready"; title: string };

export type Severity = "blocker" | "warn" | "info";

export type Finding = {
  key: FieldKey | null;
  severity: Severity;
  platform: string | null;
  message: string;
  fix: Fix | null;
};

export type FileState = "none" | "writing" | "current" | "stale" | "error";

export type FeedView = {
  show: ShowState;
  channel: Readonly<Record<FieldKey, Fact<FieldValue>>>;
  item: Readonly<Record<FieldKey, Fact<FieldValue>>>;
  sections: Sections;
  /** The notes the service renders for Copy notes and the feed: intro, live chapters and credits. */
  notesHtml: string;
  /** Display text for a drifted pin: what changed. Not part of the digest compare. */
  driftDetail?: Readonly<Record<FieldKey, string>>;
  findings: readonly Finding[];
  file: FileState;
};
