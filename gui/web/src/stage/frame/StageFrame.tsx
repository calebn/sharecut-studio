import { memo, type ReactNode, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useTimelineFocusRegion } from "../../hooks/useTimelineFocusRegion";
import { useTwoFingerTap } from "../../hooks/useTwoFingerTap";
import { PresenceGhostLayer } from "../../presence/PresenceGhostLayer";
import { rosterEntry } from "../../presence/roster";
import { usePresenceCursorSource } from "../../presence/usePresenceCursorSource";
import { canApplyPass12, isGuestSession } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { AppHeader } from "../../system/AppHeader";
import { StageBar } from "../../system/StageBar";
import { useUndoCoachTip } from "../../system/useCoachTip";
import { stageLabel } from "../../system/verbs";
import type { StageSheet } from "../../types/stage";
import { ToolsButton } from "../edit/ToolsButton";
import {
  AVAILABLE_VIEW_ANCHOR,
  type ViewAnchorAvailability,
} from "../edit/useViewAnchor";
import { AvatarStack } from "./AvatarStack";
import { BannerStack } from "./BannerStack";
import { guestPlayerCardShown } from "./guestPlayerCardShown";
import { PlayerBar } from "./PlayerBar";
import { SheetHost } from "./SheetHost";
import { STAGE_BODY_ID, StageFrameView } from "./StageFrameView";
import { StatusLive } from "./StatusLive";
import { useAnnounceStageSwitch } from "./useAnnounceStageSwitch";
import { useFrameHeaderBoundary } from "./useFrameHeaderBoundary";
import { useHeaderProps } from "./useHeaderProps";
import { useShellAttributes } from "./useShellAttributes";
import { useShortFrame } from "./useShortFrame";

export type StageFrameProps = {
  guestShare?: boolean;
  /** Content for the View and Mix sheets; History is hosted by the frame. */
  sheets?: Partial<Record<StageSheet, ReactNode>>;
  /** The stage host for the open stage. */
  children: (viewAnchor: ViewAnchorAvailability) => ReactNode;
};

function StageFrameAdapter({
  guestShare = false,
  sheets,
  children,
}: StageFrameProps) {
  const shell = useShellAttributes();
  const shortViewport = useShortViewport();
  const { stage, guest, followColorIndex, setTimelineFocused } = useDawStore(
    useShallow((s) => ({
      stage: s.stage,
      guest: isGuestSession(s.projectPath, s.guestMode, guestShare),
      followColorIndex: s.followingClientId
        ? (rosterEntry(s.sessionClients, s.followingClientId)?.meta
            ?.color_index ?? 0)
        : null,
      setTimelineFocused: s.setTimelineFocused,
    })),
  );
  useAnnounceStageSwitch(stage);
  const headerProps = useHeaderProps();
  const rootRef = useRef<HTMLDivElement>(null);
  usePresenceCursorSource(rootRef);
  const shortFrame = useShortFrame(rootRef);
  useFrameHeaderBoundary(rootRef, shell);
  const toolsRef = useRef<HTMLButtonElement | null>(null);
  const undoEnabled = useDawStore(
    (s) =>
      s.project != null &&
      canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities),
  );
  const twoFingerUndo = shell === "phone" && undoEnabled;
  useTwoFingerTap(rootRef, { enabled: twoFingerUndo });
  // The Role chip hint and the Undo tip share the header's edge; Undo waits.
  const roleHintUp = headerProps.guest?.hint?.shown ?? false;
  const undoTip = useUndoCoachTip(twoFingerUndo && !roleHintUp);

  // Header and Player keep transport keys working after a click (true). Edit
  // sets its own regions inside the body; every other stage's body is not the
  // timeline.
  const headerRegion = useTimelineFocusRegion<HTMLDivElement>(
    true,
    setTimelineFocused,
  );
  const playerRegion = useTimelineFocusRegion<HTMLDivElement>(
    true,
    setTimelineFocused,
  );
  const bodyRegion = useTimelineFocusRegion<HTMLElement>(
    false,
    setTimelineFocused,
  );

  return (
    <StageFrameView
      shell={shell}
      stage={stage}
      stageLabel={stageLabel(stage)}
      guest={guestShare}
      followColorIndex={followColorIndex}
      header={
        <AppHeader
          {...headerProps}
          undoHint={{
            text: undoTip.text,
            shown: undoTip.shown,
            onDismiss: undoTip.dismiss,
          }}
          stages={
            headerProps.stages && {
              ...headerProps.stages,
              panelId: STAGE_BODY_ID,
            }
          }
          peopleSlot={<AvatarStack variant="header" />}
          menuPeople={<AvatarStack variant="menu" />}
          compact={shortFrame}
          stagesInMenu={shell === "phone"}
          toolsSlot={
            shortFrame && stage === "edit" ? (
              <ToolsButton ref={toolsRef} />
            ) : null
          }
        />
      }
      banners={<BannerStack guestShare={guestShare} />}
      player={
        stage === "record" ||
        guestPlayerCardShown(stage, shell, guest, shortViewport) ? null : (
          <PlayerBar />
        )
      }
      tabs={
        shell === "phone" && headerProps.stages ? (
          <StageBar
            {...headerProps.stages}
            form="tabs"
            panelId={STAGE_BODY_ID}
          />
        ) : null
      }
      sheet={<SheetHost content={sheets} />}
      live={<StatusLive />}
      overlay={<PresenceGhostLayer rootRef={rootRef} />}
      bindings={{
        root: rootRef,
        header: headerRegion,
        body: stage === "edit" ? undefined : bodyRegion,
        player: playerRegion,
      }}
    >
      {children(
        shortFrame
          ? { kind: "unavailable", returnTarget: () => toolsRef.current }
          : AVAILABLE_VIEW_ANCHOR,
      )}
    </StageFrameView>
  );
}

/**
 * The app-wired frame: header, banners, the stage body slot, the Player and
 * the phone tab bar. The stage hosts slot in as children. Engines and dialogs
 * stay in `DawApp`, outside the frame, so a live take, the playhead and the
 * selection survive a stage switch.
 */
export const StageFrame = memo(StageFrameAdapter);
