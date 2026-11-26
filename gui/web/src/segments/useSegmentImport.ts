import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelSegmentImport,
  commitSegmentImport,
  previewSegmentImport,
  type SegmentImportPreview,
  type SegmentSaveResult,
} from "../api";
import { useMountedRef } from "../hooks/useMountedRef";
import { ApiError, errorMessage } from "../utils/apiError";
import { IMPORT_FAILED, importedMessage } from "./importMessages";

export type SegmentImportState =
  | { phase: "idle" }
  | { phase: "uploading"; fileName: string }
  | { phase: "preview"; preview: SegmentImportPreview; notice: string | null }
  | { phase: "committing"; preview: SegmentImportPreview }
  | { phase: "error"; fileName: string; message: string };

export type SegmentImport = {
  state: SegmentImportState;
  choose: (file: File) => void;
  add: () => void;
  cancel: () => void;
};

type Options = {
  /** The row to show once the file is in the library (or already was), and what to say. */
  onDone: (id: string, message: string) => void;
};

const IDLE: SegmentImportState = { phase: "idle" };

export function useSegmentImport({ onDone }: Options): SegmentImport {
  const [state, setState] = useState<SegmentImportState>(IDLE);
  const mounted = useMountedRef();
  const latest = useRef(state);
  const upload = useRef<AbortController | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    latest.current = state;
    done.current = onDone;
  });

  const release = useCallback(() => {
    upload.current?.abort();
    upload.current = null;
    const current = latest.current;
    if (current.phase === "preview")
      void cancelSegmentImport(current.preview.token).catch(() => {});
  }, []);

  useEffect(() => release, [release]);

  const show = useCallback(
    (next: SegmentImportState) => {
      latest.current = next;
      if (mounted.current) setState(next);
    },
    [mounted],
  );

  const choose = useCallback(
    (file: File) => {
      if (latest.current.phase === "committing") return;
      release();
      const controller = new AbortController();
      upload.current = controller;
      show({ phase: "uploading", fileName: file.name });
      previewSegmentImport(file, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) {
            void cancelSegmentImport(preview.token).catch(() => {});
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
    [release, show],
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
    if (preview.outcome === "unchanged" && preview.existing_id !== null) {
      release();
      show(IDLE);
      done.current(
        preview.existing_id,
        importedMessage(preview.name, {
          status: "unchanged",
          id: preview.existing_id,
          version: preview.version,
        }),
      );
      return;
    }
    show({ phase: "committing", preview });
    commitSegmentImport(preview.token)
      .then((result: SegmentSaveResult) => {
        show(IDLE);
        done.current(result.id, importedMessage(preview.name, result));
      })
      .catch((failure: unknown) => {
        const gone = failure instanceof ApiError && failure.status === 404;
        if (gone) {
          show({
            phase: "error",
            fileName: preview.name,
            message: errorMessage(failure, IMPORT_FAILED),
          });
          return;
        }
        show({
          phase: "preview",
          preview,
          notice: errorMessage(failure, IMPORT_FAILED),
        });
      });
  }, [release, show]);

  return { state, choose, add, cancel };
}
