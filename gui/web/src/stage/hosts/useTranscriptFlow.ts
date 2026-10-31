import { useCallback, useEffect, useRef, useState } from "react";
import {
  exportTranscript,
  listExportedTranscripts,
  type TranscriptFormat,
} from "../../api";
import {
  TRANSCRIPT_DEFAULTS,
  type TranscriptCopyState,
  type TranscriptFile,
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
  files: readonly TranscriptFile[];
  choices: readonly TranscriptFormat[];
  setChoices: (next: readonly TranscriptFormat[]) => void;
  copyState: TranscriptCopyState;
  exportNow: () => void;
  copyText: () => void;
  reload: () => void;
};

/**
 * The Deliver Transcript section's state: a dry-run preview and the files
 * already on disk, refreshed when the transcript changes, plus the synchronous
 * export and Copy. Same `TranscriptService.export` as MCP `export_transcript`
 * and `podcast transcript export`.
 *
 * `revision` is any value that changes when the transcript does.
 */
export function useTranscriptFlow(args: {
  projectPath: string | null;
  enabled: boolean;
  hasTranscript: boolean;
  revision: unknown;
}): TranscriptFlow {
  const { projectPath, enabled, hasTranscript, revision } = args;
  const [preview, setPreview] = useState<TranscriptPreviewState>({
    kind: "loading",
  });
  const [run, setRun] = useState<TranscriptRun>({ phase: "idle" });
  const [files, setFiles] = useState<readonly TranscriptFile[]>([]);
  const [choices, setChoices] =
    useState<readonly TranscriptFormat[]>(TRANSCRIPT_DEFAULTS);
  const [copyState, setCopyState] = useState<TranscriptCopyState>("idle");
  const [reloads, setReloads] = useState(0);
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const runRef = useRef(run);
  runRef.current = run;
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const hadPreview = useRef(false);
  const pathRef = useRef(projectPath);
  pathRef.current = projectPath;
  const lastRevision = useRef(revision);

  useEffect(() => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setRun({ phase: "idle" });
    setChoices(TRANSCRIPT_DEFAULTS);
    setCopyState("idle");
    setFiles([]);
    setPreview({ kind: "loading" });
    hadPreview.current = false;
  }, [projectPath]);

  useEffect(() => {
    if (Object.is(lastRevision.current, revision)) return;
    lastRevision.current = revision;
    setRun((current) =>
      current.phase === "done" ? { phase: "idle" } : current,
    );
  }, [revision]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` and `reloads` only restart the fetch.
  useEffect(() => {
    if (!enabled || !projectPath) return;
    if (!hasTranscript) {
      setPreview({ kind: "none" });
      setFiles([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        const { signal } = controller;
        Promise.all([
          exportTranscript(
            projectPath,
            { formats: TRANSCRIPT_DEFAULTS, dry_run: true },
            { signal },
          ),
          listExportedTranscripts(projectPath, { signal }),
        ])
          .then(([result, listed]) => {
            if (signal.aborted) return;
            hadPreview.current = true;
            setPreview(previewStateOf(result));
            setFiles(transcriptFilesOf(listed));
          })
          .catch((err) => {
            if (signal.aborted || isAbortError(err)) return;
            setPreview({ kind: "failed", cause: errorMessage(err) });
          });
      },
      hadPreview.current ? REFRESH_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, projectPath, hasTranscript, revision, reloads]);

  const exportNow = useCallback(() => {
    if (!projectPath || runRef.current.phase === "writing") return;
    const formats = choicesRef.current;
    if (formats.length === 0) return;
    const started = lastRevision.current;
    setRun({ phase: "writing" });
    exportTranscript(projectPath, { formats })
      .then((result) => {
        if (pathRef.current !== projectPath) return;
        const edited = !Object.is(lastRevision.current, started);
        setRun(
          edited
            ? { phase: "idle" }
            : { phase: "done", files: transcriptFilesOf(result.files) },
        );
        setReloads((n) => n + 1);
      })
      .catch((err) => {
        if (pathRef.current !== projectPath) return;
        setRun({ phase: "failed", cause: errorMessage(err) });
      });
  }, [projectPath]);

  const copyText = useCallback(() => {
    if (!projectPath) return;
    let unreadable = false;
    const text = exportTranscript(projectPath, {
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
        if (pathRef.current !== projectPath) return;
        setCopyState("copied");
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopyState("idle"), COPIED_MS);
      },
      () => {
        if (pathRef.current !== projectPath) return;
        setCopyState(unreadable ? "failed" : "blocked");
      },
    );
  }, [projectPath]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  return {
    preview,
    run,
    files,
    choices,
    setChoices,
    copyState,
    exportNow,
    copyText,
    reload,
  };
}
