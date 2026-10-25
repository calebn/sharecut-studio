import { useRef, useState } from "react";
import type {
  TranscriptReplacementOptions,
  TranscriptReplacementPreview,
} from "../api";
import { previewTranscriptReplacement, replaceTranscriptMatches } from "../api";
import { documentAuthority } from "../document/authorityState";
import { currentDocumentSeq } from "../document/cursor";
import { sameBasis } from "../document/editBasisKey";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ProjectView } from "../types/project";
import { Button, CommandButton, Field, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { errorMessage } from "../utils/apiError";

type ReplaceState =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "review"; preview: TranscriptReplacementPreview }
  | { kind: "replacing"; preview: TranscriptReplacementPreview }
  | {
      kind: "done";
      count: number;
      project: ProjectView | null;
      seq: number;
      token: string | null;
    }
  | { kind: "queued" }
  | { kind: "error"; message: string };

export function TranscriptFindReplace() {
  const { projectPath, project } = useDaw((s) => ({
    projectPath: s.projectPath,
    project: s.project,
  }));
  const [options, setOptions] = useState<TranscriptReplacementOptions>({
    search: "",
    replacement: "",
    match_case: false,
  });
  const [state, setState] = useState<ReplaceState>({ kind: "idle" });
  const [shown, setShown] = useState(100);
  const request = useRef(0);
  const busyRef = useRef(false);
  const busy = state.kind === "previewing" || state.kind === "replacing";
  const preview =
    state.kind === "review" || state.kind === "replacing"
      ? state.preview
      : null;
  const change = (fields: Partial<TranscriptReplacementOptions>) => {
    request.current += 1;
    setOptions((previous) => ({ ...previous, ...fields }));
    setState({ kind: "idle" });
  };
  const loadPreview = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const ticket = ++request.current;
    setState({ kind: "previewing" });
    try {
      const next = await previewTranscriptReplacement(projectPath, options);
      if (
        ticket === request.current &&
        useDawStore.getState().projectPath === projectPath
      ) {
        setShown(100);
        setState({ kind: "review", preview: next });
      }
    } catch (error) {
      if (ticket === request.current)
        setState({ kind: "error", message: errorMessage(error) });
    } finally {
      busyRef.current = false;
    }
  };
  const replace = async () => {
    if (!preview || busyRef.current || preview.count === 0) return;
    busyRef.current = true;
    setState({ kind: "replacing", preview });
    try {
      const result = await replaceTranscriptMatches(
        projectPath,
        options,
        preview.preview_token,
      );
      if (useDawStore.getState().projectPath !== projectPath) return;
      if (result.queued) setState({ kind: "queued" });
      else
        setState({
          kind: "done",
          count: preview.count,
          project: useDawStore.getState().project,
          seq: currentDocumentSeq(),
          token: documentAuthority.token,
        });
    } catch (error) {
      if (useDawStore.getState().projectPath === projectPath)
        setState({ kind: "error", message: errorMessage(error) });
    } finally {
      busyRef.current = false;
    }
  };
  const stale =
    state.kind === "done" &&
    (currentDocumentSeq() !== state.seq ||
      documentAuthority.token !== state.token ||
      !sameBasis(project, state.project));
  return (
    <section
      className="transcript-find-replace"
      aria-label="Find and replace transcript"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void loadPreview();
        }}
      >
        <Field label="Find">
          {(control) => (
            <input
              {...control}
              value={options.search}
              maxLength={500}
              disabled={busy}
              onChange={(event) => change({ search: event.target.value })}
            />
          )}
        </Field>
        <Field label="Replace with">
          {(control) => (
            <input
              {...control}
              value={options.replacement}
              maxLength={500}
              disabled={busy}
              onChange={(event) => change({ replacement: event.target.value })}
            />
          )}
        </Field>
        <label>
          <input
            type="checkbox"
            checked={options.match_case}
            disabled={busy}
            onChange={(event) => change({ match_case: event.target.checked })}
          />{" "}
          Match case
        </label>
        <Button
          type="submit"
          disabledReason={
            busy
              ? BUSY_REASON
              : !options.search.trim()
                ? "Enter the text to find."
                : !options.replacement.trim()
                  ? "Enter the replacement text."
                  : undefined
          }
        >
          {state.kind === "previewing" ? "Finding…" : "Preview replacements"}
        </Button>
      </form>
      <p>
        Whole words or phrases; explicit replacement punctuation takes
        precedence. Attach punctuation to a word. All source recordings and
        cut-away text. Suppressed and ignored words are skipped.
      </p>
      <InlineError message={state.kind === "error" ? state.message : null} />
      {preview && (
        <>
          <p role="status">
            {preview.count} replacement{preview.count === 1 ? "" : "s"}.{" "}
            {preview.skipped_words} suppressed or ignored words skipped.
          </p>
          {preview.matches.some((match) => match.retimes_words) && (
            <p>
              Different word counts redistribute word timing within the original
              phrase span, as manual phrase correction does. An explicit
              audibility lock on the old phrase applies to all replacement
              words.
            </p>
          )}
          <ul
            className="transcript-replacement-preview"
            aria-label="Replacement preview"
          >
            {preview.matches.slice(0, shown).map((match) => (
              <li
                key={JSON.stringify([
                  match.track_id,
                  match.source_id ?? null,
                  match.start_word_index,
                ])}
              >
                <strong>
                  {project?.tracks.find((track) => track.id === match.track_id)
                    ?.label || match.track_id}
                </strong>{" "}
                ·{" "}
                {match.source_id
                  ? `Source ${match.source_id}`
                  : "Primary recording"}{" "}
                · source {match.start.toFixed(2)}s
                <div>
                  <del>{match.before}</del> → <ins>{match.after}</ins>
                </div>
              </li>
            ))}
          </ul>
          {shown < preview.matches.length && (
            <Button onClick={() => setShown((count) => count + 100)}>
              Show more replacements
            </Button>
          )}
          <Button
            disabledReason={
              busy
                ? BUSY_REASON
                : preview.count === 0
                  ? "No matches to replace. Change the search."
                  : undefined
            }
            onClick={() => void replace()}
          >
            {state.kind === "replacing"
              ? "Replacing…"
              : `Replace all ${preview.count}`}
          </Button>
        </>
      )}
      {state.kind === "done" && (
        <div role="status">
          Replaced {state.count} instance{state.count === 1 ? "" : "s"}.{" "}
          <CommandButton
            commandId="history.undo"
            disabledReason={
              stale
                ? "The transcript changed since this replacement. Use History to review newer changes."
                : undefined
            }
          >
            Undo replacements
          </CommandButton>
          {stale && <span> Use History to review newer changes.</span>}
        </div>
      )}
      {state.kind === "queued" && (
        <p role="status">
          Replacement queued for delivery. The transcript will be checked again
          before replay. Preview again after sync to see current text.
        </p>
      )}
    </section>
  );
}
