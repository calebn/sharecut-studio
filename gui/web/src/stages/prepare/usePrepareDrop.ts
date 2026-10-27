import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { ingestFiles } from "../../ingest/ingestFiles";

/** Audio dragged over Prepare: the drop frame shows and a drop adds the files as new tracks. */
export function usePrepareDrop(enabled: boolean): {
  active: boolean;
  count: number | undefined;
} {
  return useWindowFileDrop(enabled, (files) => {
    void ingestFiles(files, { kind: "new" });
  });
}
