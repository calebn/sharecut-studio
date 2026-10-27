import { useState } from "react";
import { newTracksDropLabel } from "../../ingest/dropLabels";
import { canIngestMedia, isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { CommandMenuItem, Menu, type MenuTriggerProps } from "../../ui";
import type { AudioDropHandlers } from "./useAudioDrop";

export type PlusMenuProps = {
  dropOver?: boolean;
  fileCount?: number;
  dropHandlers?: AudioDropHandlers;
};

/**
 * The "+" row under the last track header: Import audio, an empty track, a
 * chapter at the playhead and a Record take. Audio files dropped on it become
 * new tracks.
 */
export function PlusMenu({
  dropOver = false,
  fileCount = 1,
  dropHandlers,
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
          {...dropHandlers}
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
