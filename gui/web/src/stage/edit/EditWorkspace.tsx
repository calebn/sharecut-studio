import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { execute } from "../../commands/execute";
import { runPointerCommand } from "../../commands/pointer";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../../hooks/useMediaQueryStore";
import { useTimelineFocusRegion } from "../../hooks/useTimelineFocusRegion";
import { useViewportClass } from "../../hooks/useViewportClass";
import { canEditMix, canIngestMedia, isGuestSession } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { mediaKeyOf } from "../../state/jobMedia";
import { Skeleton } from "../../system/Skeleton";
import { RangeFields } from "../../timeline/RangeFields";
import { TimelineView } from "../../timeline/TimelineView";
import { requestAutoRun, takeAutoRun } from "../../utils/openIntent";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import { HostBody } from "../hosts/HostBody";
import type { LoadFailure } from "../hosts/hostModels";
import { useStageScroll } from "../useStageScroll";
import { EditActionBar } from "./EditActionBar";
import { EditCorner } from "./EditCorner";
import { EditOverview } from "./EditOverview";
import { type EditArrangement, EditWorkspaceView } from "./EditWorkspaceView";
import { EmptySession } from "./EmptySession";
import { InspectorHost } from "./InspectorHost";
import { PhoneEditSurfaceView } from "./PhoneEditSurfaceView";
import { PlusMenu } from "./PlusMenu";
import { ScriptDivider } from "./ScriptDivider";
import { ScriptHost } from "./script/ScriptHost";
import { TrackColumn } from "./TrackColumn";
import { useAudioDrop } from "./useAudioDrop";
import { useInspectorOpen } from "./useInspectorOpen";
import { useRevealEditedLane } from "./useRevealEditedLane";
import { useScriptSize } from "./useScriptSize";
import {
  AVAILABLE_VIEW_ANCHOR,
  type ViewAnchorAvailability,
} from "./useViewAnchor";

const SIDE_BY_SIDE_MQ = "(min-width: 62.5rem)";
const subscribeSide = mediaQuerySubscription([SIDE_BY_SIDE_MQ]);
const readSide = () => matchesMedia(SIDE_BY_SIDE_MQ, true);

export type EditWorkspaceProps = {
  viewAnchor?: ViewAnchorAvailability;
  guestShare?: boolean;
  /** The project failed to load: the stage body says so, with Try again. */
  loadFailure?: LoadFailure | null;
};

function EditWorkspaceAdapter({
  viewAnchor = AVAILABLE_VIEW_ANCHOR,
  guestShare = false,
  loadFailure,
}: EditWorkspaceProps) {
  const {
    project,
    scriptCollapsed,
    scriptFocus,
    editSurface,
    setOpenSheet,
    setTimelineFocused,
    projectPath,
    guestMode,
    shareCapabilities,
    editedTrackId,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      scriptCollapsed: s.scriptCollapsed,
      scriptFocus: s.scriptFocus,
      editSurface: s.editSurface,
      setOpenSheet: s.setOpenSheet,
      setTimelineFocused: s.setTimelineFocused,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      editedTrackId: s.selection?.kind === "track" ? s.selection.trackId : null,
    })),
  );
  const shell = useViewportClass();
  const wide = useMediaQueryStore(subscribeSide, readSide, () => true);
  const arrangement: EditArrangement =
    shell === "phone"
      ? "phone"
      : shell === "tablet" && !wide
        ? "stacked"
        : "side";
  const overviewGuest = isGuestSession(projectPath, guestMode, guestShare);
  const size = useScriptSize();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  // The timeline column keeps timeline keys firing; the Script pane, the
  // divider and the Inspector do not (spec: focus regions).
  const timelineRegion = useTimelineFocusRegion<HTMLDivElement>(
    true,
    setTimelineFocused,
  );
  const dividerRegion = useTimelineFocusRegion<HTMLDivElement>(
    false,
    setTimelineFocused,
  );
  const scriptRegion = useTimelineFocusRegion<HTMLElement>(
    false,
    setTimelineFocused,
  );
  const inspectorRegion = useTimelineFocusRegion<HTMLDivElement>(
    false,
    setTimelineFocused,
  );
  const scriptScroll = useStageScroll("edit", "script", ".sys-script-body");

  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const loading = project == null;
  const emptySession = !loading && project.tracks.length === 0;
  const drop = useAudioDrop();

  const phoneLanes = editSurface === "lanes";
  const inspector = useInspectorOpen(
    shell,
    shell === "phone"
      ? phoneLanes
        ? "timeline"
        : "text"
      : scriptFocus
        ? "text"
        : "timeline",
  );

  // The Inspector column covers no lane, but a header select no longer
  // scrolls its lane whole (the old header button did, by being focused), so
  // the lane being edited is brought into view here, as the tablet needs it.
  useRevealEditedLane(
    shell !== "phone" && inspector.open ? editedTrackId : null,
  );

  const phone = arrangement === "phone";
  // Memoized: a new element would re-render the timeline it is slotted into.
  const headers = useMemo(
    () => (
      <TrackColumn
        form={phone ? "phone" : "default"}
        showSoloChip={!phone}
        addRow={
          mayIngest ? (
            <PlusMenu
              dropOver={drop.over}
              fileCount={drop.fileCount}
              dropHandlers={drop.handlers}
            />
          ) : null
        }
      />
    ),
    [phone, mayIngest, drop.over, drop.fileCount, drop.handlers],
  );

  const hasAudio = project != null && mediaKeyOf(project.tracks) !== "";
  const startTranscribe = async () => {
    const { pipelineJob, activityJob, announceStatus } = useDawStore.getState();
    if (isPipelineSlotBusy(pipelineJob) || isPipelineSlotBusy(activityJob)) {
      announceStatus("Another job is running. Try again when it finishes.", {
        tone: "error",
      });
      return;
    }
    requestAutoRun(projectPath);
    let landed = false;
    try {
      await execute("stage.prepare");
      landed = useDawStore.getState().stage === "prepare";
    } finally {
      if (!landed) takeAutoRun(projectPath);
    }
  };
  const transcribe = hasAudio ? () => void startTranscribe() : undefined;

  const state = loading
    ? "loading"
    : emptySession && mayIngest
      ? "ingest"
      : "arrange";
  const timeline =
    state === "loading" ? (
      <>
        {headers}
        <TimelineView />
      </>
    ) : state === "ingest" ? (
      <>
        {headers}
        <EmptySession drop={drop} />
      </>
    ) : (
      <TimelineView fixedPlayhead={phone} headerSlot={headers} />
    );

  // The pane is the Script region once it shows; before that the shell names it.
  const script = loading ? (
    <section aria-label="Script" className="edit-script-state">
      <Skeleton layout="list" />
    </section>
  ) : (
    <div ref={scriptScroll} className="edit-script-body">
      <ScriptHost
        key={projectPath ?? ""}
        layout={phone ? "phone" : "desktop"}
        onTranscribe={transcribe}
      />
    </div>
  );

  // The Inspector opens on Inspect (I, the verb, a double-click), never
  // because something is selected; a new selection, Esc or Close shuts it.
  const rangeFields = inspector.rangeActionsInSheet ? null : (
    <RangeFields numeric={!phone} />
  );
  const actionBar = (
    <EditActionBar form={phone ? "dock" : "floating"} root={root} />
  );
  const corner = (
    <EditCorner
      showScript={!phone}
      viewAnchor={
        viewAnchor.kind === "unavailable"
          ? viewAnchor
          : !phone && scriptFocus
            ? {
                kind: "unavailable",
                returnTarget: () =>
                  root?.querySelector<HTMLButtonElement>(
                    'button[aria-label="Find in transcript"]',
                  ) ??
                  root?.querySelector<HTMLElement>(".edit-script") ??
                  null,
              }
            : AVAILABLE_VIEW_ANCHOR
      }
    />
  );

  // The failure is the stage body, always in view (the Script pane may be
  // collapsed, the phone may be on its lanes), and a project without its
  // transcript and history is not safe to edit.
  if (loadFailure) {
    return (
      <HostBody stage="edit" shell={shell} state="error" failure={loadFailure}>
        {null}
      </HostBody>
    );
  }

  return (
    <EditWorkspaceView
      arrangement={arrangement}
      state={state}
      guest={guestShare}
      scriptHidden={scriptCollapsed}
      scriptFocus={scriptFocus}
      scriptWidthRem={size.widthRem}
      rangeFields={rangeFields}
      actionBar={actionBar}
      timeline={timeline}
      corner={corner}
      divider={
        <ScriptDivider
          widthRem={size.widthRem}
          onResize={size.resize}
          onReset={size.reset}
        />
      }
      script={script}
      overview={<EditOverview height={32} guest={overviewGuest} />}
      phone={
        <PhoneEditSurfaceView
          surface={editSurface}
          onSurfaceChange={(surface) =>
            runPointerCommand("stage.edit", { surface })
          }
          corner={corner}
          lanes={timeline}
          script={script}
          overview={<EditOverview height={16} guest={overviewGuest} />}
          bindings={{ lanes: timelineRegion, script: scriptRegion }}
          onOpenMix={
            canEditMix(projectPath, guestMode, shareCapabilities)
              ? () => setOpenSheet("mix")
              : undefined
          }
        />
      }
      sheet={
        <InspectorHost
          shell={shell}
          sheet={inspector}
          root={root}
          regionRef={inspectorRegion}
        />
      }
      bindings={{
        root: setRoot,
        timeline: timelineRegion,
        divider: dividerRegion,
        script: scriptRegion,
      }}
    />
  );
}

/**
 * The Edit stage host: the timeline with its headers, the Script pane, the
 * Inspector and the sheets that hang off them. Mounted by the frame as the
 * stage body when Edit is up; unmounting it cannot lose the view, because
 * `openStage` snapshots zoom and scroll before the swap.
 */
export const EditWorkspace = memo(EditWorkspaceAdapter);
