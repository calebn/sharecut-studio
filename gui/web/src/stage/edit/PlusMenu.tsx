import { useState } from "react";
import {
  audioFilesFromDrop,
  fileCountFromDataTransfer,
  newTracksDropLabel,
} from "../../ingest/dropLabels";
import { ingestFiles } from "../../ingest/ingestFiles";
import { canIngestMedia, isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { CommandMenuItem, Menu, type MenuTriggerProps } from "../../ui";

export type PlusMenuProps = {
  dropOver?: boolean;
  fileCount?: number;
  onDropOverChange?: (over: boolean, fileCount?: number) => void;
};

/**
 * The "+" row under the last track header: Import audio, an empty track, a
 * chapter at the playhead and a Record take, each an existing command. Audio
 * files dropped on it become new tracks, as the old row did.
 */
export function PlusMenu({
  dropOver = false,
  fileCount = 1,
  onDropOverChange,
}: PlusMenuProps) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const [open, setOpen] = useState(false);
  if (!canIngestMedia(projectPath, guestMode, shareCapabilities)) return null;
  const host = !isShareProjectKey(projectPath) && guestMode == null;
  const close = () => setOpen(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Add to episode"
      className="plus-menu ui-menu-root"
      trigger={(t: MenuTriggerProps) => (
        <button
          type="button"
          className={`track-add-row plus-menu-trigger${dropOver ? " lane-drop-target" : ""}`}
          {...t}
          title="Add a track, import audio or add a chapter"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            onDropOverChange?.(
              true,
              Math.max(1, fileCountFromDataTransfer(e.dataTransfer)),
            );
          }}
          onDragLeave={() => onDropOverChange?.(false)}
          onDrop={(e) => {
            e.preventDefault();
            onDropOverChange?.(false);
            const files = audioFilesFromDrop(e.dataTransfer.files);
            if (files.length) void ingestFiles(files, { kind: "new" });
          }}
        >
          {dropOver ? newTracksDropLabel(fileCount) : "+"}
        </button>
      )}
    >
      <CommandMenuItem commandId="media.import" onSelect={close} />
      <CommandMenuItem commandId="track.add" onSelect={close} />
      {host ? (
        <>
          <CommandMenuItem commandId="edit.addChapter" onSelect={close} />
          <CommandMenuItem commandId="record.openPanel" onSelect={close} />
        </>
      ) : null}
    </Menu>
  );
}
