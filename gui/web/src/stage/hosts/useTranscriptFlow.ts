import { useCallback, useEffect, useRef, useState } from "react";
import { exportTranscript, type TranscriptFormat } from "../../api";
import {
  TRANSCRIPT_DEFAULTS,
  type TranscriptCopyState,
  type TranscriptPreviewState,
  type TranscriptRun,
} from "../../stages/deliver/transcriptLogic";
import { errorMessage, isAbortError } from "../../utils/apiError";
import { copyWhenReady } from "./copyWhenReady";
import { previewStateOf, transcriptFilesOf } from "./deliverTranscript";

const COPIED_MS = 2000;
const REFRESH_DEBOUNCE_MS = 300;

export type TranscriptFlow = {
  preview: TranscriptPreviewState;
  run: TranscriptRun;
  /** Counts each write, so the file list reads the folder again. */
  written: number;
  choices: readonly TranscriptFormat[];
  setChoices: (next: readonly TranscriptFormat[]) => void;
  copyState: TranscriptCopyState;
  exportNow: () => void;
  copyText: () => void;
  reload: () => void;
};

type TranscriptOwner = {
  projectPath: string | null;
  projectEpoch: number;
};

type PreviewRequest = {
  owner: TranscriptOwner;
  enabled: boolean;
  hasTranscript: boolean;
  revision: unknown;
  generation: number;
  delayMs: number;
};

type WriteAttempt = { owner: TranscriptOwner; revision: unknown };
type CopyAttempt = { owner: TranscriptOwner };
type CopyReceipt = { value: TranscriptCopyState };

type TranscriptState = {
  owner: TranscriptOwner;
  request: PreviewRequest;
  preview: TranscriptPreviewState | null;
  hadPreview: boolean;
  run: TranscriptRun;
  writeAttempt: WriteAttempt | null;
  written: number;
  choices: readonly TranscriptFormat[];
  copy: CopyReceipt | null;
  pendingCopy: CopyAttempt | null;
};

/**
 * Owns a project's transcript preview, file writes and clipboard receipts.
 * A revision refresh retains its prior preview and leaves a running write alone;
 * that write only reports done if the revision it started with is still current.
 */
export function useTranscriptFlow(args: {
  projectPath: string | null;
  projectEpoch: number;
  enabled: boolean;
  hasTranscript: boolean;
  revision: unknown;
}): TranscriptFlow {
  const { projectPath, projectEpoch, enabled, hasTranscript, revision } = args;
  const [state, setState] = useState<TranscriptState>(() => {
    const owner = { projectPath, projectEpoch };
    const request = {
      owner,
      enabled,
      hasTranscript,
      revision,
      generation: 0,
      delayMs: 0,
    };
    return {
      owner,
      request,
      preview:
        enabled && projectPath && !hasTranscript ? { kind: "none" } : null,
      hadPreview: false,
      run: { phase: "idle" },
      writeAttempt: null,
      written: 0,
      choices: TRANSCRIPT_DEFAULTS,
      copy: null,
      pendingCopy: null,
    };
  });
  const { owner, request } = state;
  if (
    owner.projectPath !== projectPath ||
    owner.projectEpoch !== projectEpoch
  ) {
    const nextOwner = { projectPath, projectEpoch };
    const nextRequest = {
      owner: nextOwner,
      enabled,
      hasTranscript,
      revision,
      generation: request.generation,
      delayMs: 0,
    };
    setState({
      owner: nextOwner,
      request: nextRequest,
      preview:
        enabled && projectPath && !hasTranscript ? { kind: "none" } : null,
      hadPreview: false,
      run: { phase: "idle" },
      writeAttempt: null,
      written: state.written,
      choices: TRANSCRIPT_DEFAULTS,
      copy: null,
      pendingCopy: null,
    });
  } else if (
    request.enabled !== enabled ||
    request.hasTranscript !== hasTranscript ||
    !Object.is(request.revision, revision)
  ) {
    const nextRequest = {
      ...request,
      enabled,
      hasTranscript,
      revision,
      delayMs: state.hadPreview ? REFRESH_DEBOUNCE_MS : 0,
    };
    setState({
      ...state,
      request: nextRequest,
      preview:
        enabled && projectPath && !hasTranscript
          ? { kind: "none" }
          : state.preview,
      run:
        !Object.is(request.revision, revision) && state.run.phase === "done"
          ? { phase: "idle" }
          : state.run,
    });
  }

  const activeOwner = useRef<TranscriptOwner | null>(null);
  const inFlight = useRef<WriteAttempt | null>(null);
  const copying = useRef<CopyAttempt | null>(null);
  const copiedTimer = useRef<{
    owner: TranscriptOwner;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  useEffect(() => {
    activeOwner.current = owner;
    return () => {
      if (activeOwner.current === owner) activeOwner.current = null;
      if (copying.current?.owner === owner) copying.current = null;
      if (copiedTimer.current?.owner === owner) {
        clearTimeout(copiedTimer.current.timer);
        copiedTimer.current = null;
      }
    };
  }, [owner]);

  useEffect(() => {
    const { projectPath } = request.owner;
    if (!request.enabled || !projectPath || !request.hasTranscript) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const { signal } = controller;
      exportTranscript(
        projectPath,
        { formats: TRANSCRIPT_DEFAULTS, dry_run: true },
        { signal },
      )
        .then((result) => {
          if (signal.aborted) return;
          setState((current) =>
            current.request === request
              ? {
                  ...current,
                  hadPreview: true,
                  preview: previewStateOf(result),
                }
              : current,
          );
        })
        .catch((err) => {
          if (signal.aborted || isAbortError(err)) return;
          setState((current) =>
            current.request === request
              ? {
                  ...current,
                  preview: { kind: "failed", cause: errorMessage(err) },
                }
              : current,
          );
        });
    }, request.delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request]);

  const setChoices = useCallback(
    (next: readonly TranscriptFormat[]) => {
      setState((current) =>
        current.owner === owner ? { ...current, choices: next } : current,
      );
    },
    [owner],
  );

  const exportNow = useCallback(() => {
    if (
      !owner.projectPath ||
      activeOwner.current !== owner ||
      inFlight.current?.owner === owner
    )
      return;
    const formats = state.choices;
    if (formats.length === 0) return;
    const attempt: WriteAttempt = { owner, revision: request.revision };
    inFlight.current = attempt;
    setState((current) =>
      current.owner === owner
        ? { ...current, writeAttempt: attempt, run: { phase: "writing" } }
        : current,
    );
    exportTranscript(owner.projectPath, { formats })
      .then((result) => {
        setState((current) =>
          current.owner === owner && current.writeAttempt === attempt
            ? {
                ...current,
                run: Object.is(current.request.revision, attempt.revision)
                  ? { phase: "done", files: transcriptFilesOf(result.files) }
                  : { phase: "idle" },
                request: {
                  ...current.request,
                  generation: current.request.generation + 1,
                  delayMs: current.hadPreview ? REFRESH_DEBOUNCE_MS : 0,
                },
                written: current.written + 1,
              }
            : current,
        );
      })
      .catch((err) => {
        setState((current) =>
          current.owner === owner && current.writeAttempt === attempt
            ? {
                ...current,
                run: { phase: "failed", cause: errorMessage(err) },
              }
            : current,
        );
      })
      .finally(() => {
        if (inFlight.current === attempt) inFlight.current = null;
      });
  }, [owner, request.revision, state.choices]);

  const copyText = useCallback(() => {
    if (!owner.projectPath || activeOwner.current !== owner) return;
    const attempt: CopyAttempt = { owner };
    copying.current = attempt;
    setState((current) =>
      current.owner === owner ? { ...current, pendingCopy: attempt } : current,
    );
    let unreadable = false;
    const text = exportTranscript(owner.projectPath, {
      formats: ["txt"],
      dry_run: true,
      with_text: true,
    }).then((result) => {
      if (result.text == null) throw new Error("The server sent no text.");
      return result.text;
    });
    text.catch(() => {
      unreadable = true;
    });
    copyWhenReady(text).then(
      () => {
        if (copying.current !== attempt || activeOwner.current !== owner)
          return;
        const receipt: CopyReceipt = { value: "copied" };
        setState((current) =>
          current.owner === owner && current.pendingCopy === attempt
            ? { ...current, copy: receipt }
            : current,
        );
        if (copiedTimer.current) clearTimeout(copiedTimer.current.timer);
        const timer = setTimeout(() => {
          setState((current) =>
            current.copy === receipt ? { ...current, copy: null } : current,
          );
          if (copiedTimer.current?.timer === timer) copiedTimer.current = null;
        }, COPIED_MS);
        copiedTimer.current = { owner, timer };
      },
      () => {
        if (copying.current !== attempt || activeOwner.current !== owner)
          return;
        const receipt: CopyReceipt = {
          value: unreadable ? "failed" : "blocked",
        };
        setState((current) =>
          current.owner === owner && current.pendingCopy === attempt
            ? { ...current, copy: receipt }
            : current,
        );
      },
    );
  }, [owner]);

  const reload = useCallback(() => {
    setState((current) =>
      current.owner === owner
        ? {
            ...current,
            request: {
              ...current.request,
              generation: current.request.generation + 1,
              delayMs: current.hadPreview ? REFRESH_DEBOUNCE_MS : 0,
            },
          }
        : current,
    );
  }, [owner]);

  return {
    preview: state.preview ?? { kind: "loading" },
    run: state.run,
    written: state.written,
    choices: state.choices,
    setChoices,
    copyState: state.copy?.value ?? "idle",
    exportNow,
    copyText,
    reload,
  };
}
