/**
 * What the Podcast listing section draws. The host resolves the feed on the
 * server and sends this view; the section never derives a value itself.
 * Every fact says where its value came from, so the UI can mark auto values,
 * flag a pin whose source changed, and show the fix for a missing one.
 */

export const PIN_KEYS = [
  "item.title",
  "item.intro",
  "item.notes",
  "item.enclosure.url",
] as const;
export type PinKey = (typeof PIN_KEYS)[number];

/** Owners of the facts the listing reads but never edits. */
export type SourceOwner = "chapters" | "clips" | "speakers" | "transcript";

/** A change to a pinned fact. Both ends of the wire, and every surface, speak only this. */
export type FeedEdit =
  | { op: "set"; key: PinKey; value: string }
  | { op: "unset"; key: PinKey };

export type DriftSource = "chapters" | "speakers" | "soundbites" | "transcript";

export type Derived = { kind: "derived"; rule: string };
export type Inherited = { kind: "inherited"; from: "show" };
export type Measured = { kind: "measured"; file: string };
export type Minted = { kind: "minted"; at: string };
export type Pinned = {
  kind: "pinned";
  by: "person" | "agent";
  /** The source that changed since the pin was made. */
  drifted: DriftSource | null;
};
export type Resolved = Derived | Inherited | Measured | Minted | Pinned;

export type FixAction =
  | { kind: "edit"; key: PinKey }
  | { kind: "show" }
  | { kind: "export" }
  | { kind: "art" }
  | { kind: "open"; owner: SourceOwner };
export type Fix = { label: string; action: FixAction };

export type Pending = { kind: "pending"; why: string; fix: Fix | null };

export type Known<T> = { value: T; source: Resolved };
export type Missing = { value: null; source: Pending };
export type Fact<T> = Known<T> | Missing;

export type Art = { src: string; alt: string };
export type FeedChapter = { at: number; title: string };
export type CreditRole = "host" | "guest";
export type Credit = { name: string; role: CreditRole; colorIndex: number };
export type TranscriptFormat = "SRT" | "VTT";
export type Soundbite = { title: string; start: number; end: number };
export type AudioFile = { mime: string; bytes: number };

export type ItemFacts = {
  title: Fact<string>;
  intro: Fact<string>;
  /** A whole-text pin over the notes the listing composes from intro, chapters and credits. */
  notes: Fact<string> | null;
  /** ISO timestamp. */
  publishedAt: Fact<string>;
  /** Seconds. */
  duration: Fact<number>;
  art: Fact<Art>;
  hosting: Fact<string>;
  file: Fact<AudioFile>;
  chapters: Fact<readonly FeedChapter[]>;
  credits: Fact<readonly Credit[]>;
  transcripts: Fact<readonly TranscriptFormat[]>;
  soundbites: Fact<readonly Soundbite[]>;
};

export type ShowState =
  | { kind: "ready"; title: string }
  | {
      kind: "none";
      /** What the speakers already tell us. */
      suggest: { language: string; hosts: readonly Credit[] };
    };

export type Severity = "blocker" | "warn" | "info";
export type Platform =
  | "Apple"
  | "Spotify"
  | "YouTube"
  | "Podcasting 2.0"
  | "RSS";

export type Finding = {
  id: string;
  severity: Severity;
  platform: Platform | null;
  message: string;
  fix: Fix | null;
};

export type FileState = "none" | "current" | "stale";

export type FeedView = {
  show: ShowState;
  item: ItemFacts;
  findings: readonly Finding[];
  file: FileState;
};
