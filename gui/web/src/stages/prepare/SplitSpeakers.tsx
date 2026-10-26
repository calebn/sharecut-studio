import { useId } from "react";
import { TOAST_UNDO_MS, Toast, type ToastState } from "../../ui";
import type {
  PrepareSession,
  PrepareSource,
  SourceActions,
} from "./prepareTypes";
import { SessionSources } from "./SessionSources";

export type SplitPhase = "prompt" | "splitting" | "name-voices" | "failed";

export type SplitSpeakersProps = {
  phase: SplitPhase;
  /** The session that holds the recording. */
  session: Omit<PrepareSession, "sources">;
  /** The one recording of several people. */
  recording: PrepareSource;
  /** The cards the recording became, one per voice, once it is split. */
  voices: readonly PrepareSource[];
  actions: SourceActions;
  /** "Split into 3 voices." with Undo; null once it is gone. */
  toast: ToastState | null;
  onUndo: () => void;
  onDismissToast: () => void;
};

/** The recording's card in the state the phase calls for. */
function recordingFor(phase: SplitPhase, source: PrepareSource): PrepareSource {
  switch (phase) {
    case "prompt":
      return { ...source, state: "split-prompt" };
    case "splitting":
      return { ...source, state: "splitting" };
    case "failed":
      return {
        ...source,
        state: "failed",
        cause: source.cause ?? "Could not tell the voices apart.",
      };
    case "name-voices":
      return source;
  }
}

/**
 * Splitting one recording into voices, in place on its Source card: the
 * question and the voice count, then the progress, then a card per voice that
 * is named after hearing it. There is no dialog; Undo is a toast.
 */
export function SplitSpeakers({
  phase,
  session,
  recording,
  voices,
  actions,
  toast,
  onUndo,
  onDismissToast,
}: SplitSpeakersProps) {
  const headingId = useId();
  const sources =
    phase === "name-voices" ? voices : [recordingFor(phase, recording)];
  return (
    <section className="sys-split" aria-labelledby={headingId}>
      <h2 id={headingId} className="sys-prepare-title">
        Sources
      </h2>
      <SessionSources
        session={{ ...session, sources }}
        firstIndex={1}
        actions={actions}
      />
      <Toast
        toast={phase === "name-voices" ? toast : null}
        onUndo={onUndo}
        onDismiss={onDismissToast}
        timeoutMs={TOAST_UNDO_MS}
      />
    </section>
  );
}
