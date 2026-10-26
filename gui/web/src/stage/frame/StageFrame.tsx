import { memo, type ReactNode, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTimelineFocusRegion } from "../../hooks/useTimelineFocusRegion";
import { PresenceGhostLayer } from "../../presence/PresenceGhostLayer";
import { usePresenceCursorSource } from "../../presence/usePresenceCursorSource";
import { useDawStore } from "../../state/dawStore";
import { AppHeader } from "../../system/AppHeader";
import { StageBar } from "../../system/StageBar";
import { STAGES } from "../../system/verbs";
import type { StageSheet } from "../../types/stage";
import { BannerStack } from "./BannerStack";
import { HeaderPeople } from "./HeaderPeople";
import type { LoadFailure } from "./LoadFailureBanner";
import { PlayerBar } from "./PlayerBar";
import { SheetHost } from "./SheetHost";
import { STAGE_BODY_ID, StageFrameView } from "./StageFrameView";
import { StatusLive } from "./StatusLive";
import { useHeaderProps } from "./useHeaderProps";
import { useShellAttributes } from "./useShellAttributes";
import { useStageBarProps } from "./useStageBarProps";

export type StageFrameProps = {
  guestShare?: boolean;
  attentionHost?: HTMLElement | null;
  loadFailure?: LoadFailure | null;
  /** Alerts that stay above the stage body. */
  alerts?: ReactNode;
  /** Content for the View and Mix sheets; History is hosted by the frame. */
  sheets?: Partial<Record<StageSheet, ReactNode>>;
  /** The stage host for the open stage. */
  children: ReactNode;
};

function StageFrameAdapter({
  guestShare = false,
  attentionHost,
  loadFailure,
  alerts,
  sheets,
  children,
}: StageFrameProps) {
  const shell = useShellAttributes();
  const { stage, following, setTimelineFocused } = useDawStore(
    useShallow((s) => ({
      stage: s.stage,
      following: Boolean(s.followingClientId),
      setTimelineFocused: s.setTimelineFocused,
    })),
  );
  const headerProps = useHeaderProps();
  const stageBar = useStageBarProps();
  const rootRef = useRef<HTMLDivElement>(null);
  usePresenceCursorSource(rootRef);

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

  const stageLabel = STAGES.find((s) => s.id === stage)?.label ?? "Stage";
  return (
    <StageFrameView
      shell={shell}
      stage={stage}
      stageLabel={stageLabel}
      guest={guestShare}
      following={following}
      header={
        <AppHeader
          {...headerProps}
          stages={
            headerProps.stages && {
              ...headerProps.stages,
              panelId: STAGE_BODY_ID,
            }
          }
          peopleSlot={<HeaderPeople />}
        />
      }
      banners={
        <BannerStack
          guestShare={guestShare}
          attentionHost={attentionHost}
          loadFailure={loadFailure}
        />
      }
      alerts={alerts}
      player={stage === "record" ? null : <PlayerBar />}
      tabs={
        shell === "phone" && stageBar ? (
          <StageBar {...stageBar} form="tabs" panelId={STAGE_BODY_ID} />
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
      {children}
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
