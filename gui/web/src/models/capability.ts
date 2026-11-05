import type { SystemIconName } from "../system/icons";
import type { ModelNeeded } from "../utils/apiError";
import type { ModelView } from "./types";

export const WHISPER = "whisper";
export const WORD_ALIGNER = "word-aligner";

type Capability = {
  /** The row name in the Models sheet: what the model does for the person. */
  name: string;
  /** How a step that lacks it says so: "Needs {what}". */
  what: string;
  icon: SystemIconName;
};

const CAPABILITIES: Record<string, Capability> = {
  [WHISPER]: {
    name: "Transcription",
    what: "the transcription model",
    icon: "text-cursor-input",
  },
  [WORD_ALIGNER]: {
    name: "Word timing",
    what: "word timing",
    icon: "clock",
  },
  "speaker-ecapa": {
    name: "Speaker split",
    what: "the speaker model",
    icon: "split",
  },
  rnnoise: {
    name: "Noise reduction",
    what: "noise reduction",
    icon: "audio-waveform",
  },
};

export function capabilityOf(id: string, label: string): Capability {
  return (
    CAPABILITIES[id] ?? {
      name: label,
      what: label.toLowerCase(),
      icon: "cloud-download",
    }
  );
}

export type WhisperSize = { id: string; name: string; size: string };

/** The three sizes the person picks from; `size` is the catalog's, used until the server lists it. */
export const WHISPER_SIZES: readonly WhisperSize[] = [
  { id: "tiny.en", name: "Fast", size: "75 MB" },
  { id: "small.en", name: "Balanced", size: "500 MB" },
  { id: "large-v3-turbo", name: "Best", size: "1.6 GB" },
];

/** A size as the sheet writes it: "1.6 GB", without the registry's tilde. */
export function plainSize(size: string): string {
  return size.replace(/^~\s*/, "");
}

/** The model a step stopped on, or one the sheet lists, reduced to what a need row asks. */
export type NeedTarget = Pick<ModelNeeded, "id" | "variant" | "label" | "size">;

export function targetOfRow(row: ModelView): NeedTarget {
  return {
    id: row.id,
    variant: row.variant,
    label: row.label,
    size: row.size,
  };
}

/** True when the row is installed, and for Whisper is the size the step asked for. */
export function rowInstalled(
  row: ModelView | null,
  need: Pick<NeedTarget, "id" | "variant">,
): boolean {
  return (
    row?.state.kind === "installed" &&
    (need.id !== WHISPER || !need.variant || row.variant === need.variant)
  );
}

const ORDER = [WHISPER, WORD_ALIGNER, "speaker-ecapa", "rnnoise"];

/** The Models sheet lists capabilities in the order a person meets them. */
export function inSheetOrder<T extends { id: string }>(
  rows: readonly T[],
): T[] {
  const rank = (id: string) => {
    const at = ORDER.indexOf(id);
    return at === -1 ? ORDER.length : at;
  };
  return [...rows].sort((a, b) => rank(a.id) - rank(b.id));
}
