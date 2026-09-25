import { execute } from "../commands/execute";
import { useBladeCut } from "../hooks/useBladeCut";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { BottomSheet, Button, CommandButton, InlineError } from "../ui";
import { formatTime } from "../utils/time";
import { ToolModeToggle } from "./ToolModeToggle";

/** Ferrite-style bottom tool rail + blade confirm sheet (phone/tablet). */
export function EditingToolRail() {
  const {
    toolMode,
    commentMode,
    playheadSec,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDaw((s) => ({
    toolMode: s.toolMode,
    commentMode: s.commentMode,
    playheadSec: s.playheadSec,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const { allowed, busy, error, bladeConfirmSec, trackIdsForCut } =
    useBladeCut();
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);

  if (!allowed && !mayIngest) {
    return null;
  }

  return (
    <>
      <div className="editing-tool-rail" aria-label="Editing tools">
        {allowed ? <ToolModeToggle compact /> : null}
        {mayIngest ? (
          <>
            <CommandButton commandId="track.add" title="Add empty track">
              + Track
            </CommandButton>
            <CommandButton commandId="media.import" title="Import audio files">
              Import
            </CommandButton>
          </>
        ) : null}
        {allowed && toolMode === "blade" && !commentMode ? (
          <CommandButton
            commandId="edit.bladeCut"
            args={{ atTime: playheadSec }}
            disabled={busy}
            title="Split selected tracks at playhead"
          >
            Cut at playhead
          </CommandButton>
        ) : null}
      </div>
      {allowed ? (
        <BottomSheet
          open={bladeConfirmSec != null}
          onClose={() => {
            void execute("edit.bladeCut.cancel", {}, { skipWhen: true });
          }}
          title="Confirm blade cut"
        >
          {bladeConfirmSec != null ? (
            <div className="blade-confirm-sheet">
              <p>
                Split at <strong>{formatTime(bladeConfirmSec)}</strong> on{" "}
                {trackIdsForCut.length
                  ? trackIdsForCut.join(", ")
                  : "all dialogue tracks"}
                .
              </p>
              <InlineError message={error} />
              <div className="blade-confirm-actions">
                <CommandButton commandId="edit.bladeCut.cancel" disabled={busy}>
                  Cancel
                </CommandButton>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void execute(
                      "edit.bladeCut.confirm",
                      {},
                      { skipWhen: true },
                    );
                    void execute("tool.blade", {}, { skipWhen: true });
                  }}
                >
                  {busy ? "Cutting…" : "Cut"}
                </Button>
              </div>
            </div>
          ) : null}
        </BottomSheet>
      ) : null}
    </>
  );
}
