import { useCallback, useEffect, useRef, useState } from "react";
import { useMountedRef } from "../../hooks/useMountedRef";
import { ApiError, errorMessage } from "../../utils/apiError";
import { IMPORT_FAILED } from "./importCopy";

/** What every staged import holds: the token that names the waiting file, and what to call it. */
export type Staged = { token: string; name: string };

export type StagedImportState<P extends Staged> =
  | { phase: "idle" }
  | { phase: "uploading"; fileName: string }
  | { phase: "preview"; preview: P; notice: string | null }
  | { phase: "committing"; preview: P }
  | { phase: "error"; fileName: string; message: string };

export type StagedImport<P extends Staged> = {
  state: StagedImportState<P>;
  choose: (file: File) => void;
  add: () => void;
  cancel: () => void;
};

/** Where a failed commit leaves the sheet: back on the preview to try again, or on the error. */
export type CommitFailure<P extends Staged = Staged> =
  | { phase: "preview"; notice: string; preview?: P }
  | { phase: "error"; message: string };

export type StagedImportConfig<P extends Staged, R> = {
  /** Uploads the file and returns what adding it would do. */
  stage: (file: File, signal: AbortSignal) => Promise<P>;
  commit: (preview: P) => Promise<R>;
  /** Drops the staged file on the service; failures are ignored. */
  cancel: (token: string) => Promise<void>;
  /** Called with the result once the commit succeeded. */
  onCommitted: (preview: P, result: R) => void;
  /**
   * A preview that needs no commit (nothing would change): when this returns a function
   * the staged file is dropped, the sheet closes and the function runs instead.
   */
  settleWithoutCommit?: (preview: P) => (() => void) | null;
  /** Decides what a failed commit leaves; the default keeps the preview unless the file expired. */
  onCommitFailed?: (failure: unknown, preview: P) => CommitFailure<P>;
  /** Called when a new file is chosen, before it uploads. */
  onChosen?: () => void;
};

const IDLE = { phase: "idle" } as const;

function defaultFailure(failure: unknown): CommitFailure<never> {
  const message = errorMessage(failure, IMPORT_FAILED);
  if (failure instanceof ApiError && failure.status === 404)
    return { phase: "error", message };
  return { phase: "preview", notice: message };
}

/**
 * The phase machine every staged import shares: idle, uploading, preview, committing,
 * error. A file is staged on the service at preview; closing (or unmounting) while it
 * waits drops it. The per-kind pieces come in through `config`.
 */
export function useStagedImport<P extends Staged, R>(
  config: StagedImportConfig<P, R>,
): StagedImport<P> {
  const [state, setState] = useState<StagedImportState<P>>(IDLE);
  const mounted = useMountedRef();
  const latest = useRef<StagedImportState<P>>(state);
  const upload = useRef<AbortController | null>(null);
  const setup = useRef(config);
  useEffect(() => {
    latest.current = state;
    setup.current = config;
  });

  const release = useCallback(() => {
    upload.current?.abort();
    upload.current = null;
    const current = latest.current;
    if (current.phase === "preview")
      void setup.current.cancel(current.preview.token).catch(() => {});
  }, []);

  useEffect(() => release, [release]);

  const show = useCallback(
    (next: StagedImportState<P>) => {
      latest.current = next;
      if (mounted.current) setState(next);
    },
    [mounted],
  );

  const choose = useCallback(
    (file: File) => {
      if (!mounted.current || latest.current.phase === "committing") return;
      release();
      setup.current.onChosen?.();
      const controller = new AbortController();
      upload.current = controller;
      show({ phase: "uploading", fileName: file.name });
      setup.current
        .stage(file, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) {
            void setup.current.cancel(preview.token).catch(() => {});
            return;
          }
          upload.current = null;
          show({ phase: "preview", preview, notice: null });
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          upload.current = null;
          show({
            phase: "error",
            fileName: file.name,
            message: errorMessage(failure, IMPORT_FAILED),
          });
        });
    },
    [mounted, release, show],
  );

  const cancel = useCallback(() => {
    if (latest.current.phase === "committing") return;
    release();
    show(IDLE);
  }, [release, show]);

  const add = useCallback(() => {
    const current = latest.current;
    if (current.phase !== "preview") return;
    const { preview } = current;
    const settle = setup.current.settleWithoutCommit?.(preview) ?? null;
    if (settle) {
      release();
      show(IDLE);
      settle();
      return;
    }
    show({ phase: "committing", preview });
    setup.current
      .commit(preview)
      .then((result) => {
        show(IDLE);
        setup.current.onCommitted(preview, result);
      })
      .catch((failure: unknown) => {
        const next =
          setup.current.onCommitFailed?.(failure, preview) ??
          defaultFailure(failure);
        if (next.phase === "error") {
          // Giving up: the file is no use to the service any more (or already gone).
          void setup.current.cancel(preview.token).catch(() => {});
          show({
            phase: "error",
            fileName: preview.name,
            message: next.message,
          });
          return;
        }
        show({
          phase: "preview",
          preview: next.preview ?? preview,
          notice: next.notice,
        });
      });
  }, [release, show]);

  return { state, choose, add, cancel };
}
