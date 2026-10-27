import { memo, type RefCallback, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { isRangeSelection } from "../../edit/rangeSelection";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../../hooks/useMediaQueryStore";
import { useTimelineFocusRegion } from "../../hooks/useTimelineFocusRegion";
import { useViewportClass } from "../../hooks/useViewportClass";
import { Inspector } from "../../inspector/Inspector";
import { TranscriptPanel } from "../../panels/TranscriptPanel";
import { canEditMix, canIngestMedia } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { Cover } from "../../system/Cover";
import { Skeleton } from "../../system/Skeleton";
import { RangeActions } from "../../timeline/RangeActions";
import { TimelineView } from "../../timeline/TimelineView";
import { TrackHeadersColumn } from "../../tracks/TrackHeadersColumn";
import { oneWordOf } from "../../utils/rangeSelect";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { EditCorner } from "./EditCorner";
import { EditToolStrip } from "./EditToolStrip";
import { type EditArrangement, EditWorkspaceView } from "./EditWorkspaceView";
import { EmptySession } from "./EmptySession";
import { InspectorSheet } from "./InspectorSheet";
import { PhoneEditSurfaceView } from "./PhoneEditSurfaceView";
import { PlusMenu } from "./PlusMenu";
import { ScriptDivider } from "./ScriptDivider";
import { useAudioDrop } from "./useAudioDrop";
import { useScriptSize } from "./useScriptSize";
import { useSelectionSheet } from "./useSelectionSheet";

const SIDE_BY_SIDE_MQ = "(min-width: 62.5rem)";
const subscribeSide = mediaQuerySubscription([SIDE_BY_SIDE_MQ]);
const readSide = () => matchesMedia(SIDE_BY_SIDE_MQ, true);

export type EditWorkspaceProps = {
  guestShare?: boolean;
  /** Where the compact Inspector's toast lands. */
  feedbackHostRef?: RefCallback<HTMLDivElement>;
  /** The transcript and history failed to load: the Script pane says so. */
  loadFailure?: LoadFailure | null;
};

function EditWorkspaceAdapter({
  guestShare = false,
  feedbackHostRef,
  loadFailure,
}: EditWorkspaceProps) {
  const {
    project,
    selection,
    scriptCollapsed,
    scriptFocus,
    editSurface,
    setEditSurface,
    setOpenSheet,
    setTimelineFocused,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      selection: s.selection,
      scriptCollapsed: s.scriptCollapsed,
      scriptFocus: s.scriptFocus,
      editSurface: s.editSurface,
      setEditSurface: s.setEditSurface,
      setOpenSheet: s.setOpenSheet,
      setTimelineFocused: s.setTimelineFocused,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
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
  const size = useScriptSize();

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
  const scriptScroll = useStageScroll("edit", "script", ".transcript-list");

  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const loading = project == null;
  const emptySession = !loading && project.tracks.length === 0;
  const drop = useAudioDrop();

  const sheetShell = shell === "phone" || shell === "tablet" ? shell : null;
  const phoneLanes = editSurface === "lanes";
  const selectionSheet = useSelectionSheet(
    sheetShell,
    shell === "phone"
      ? phoneLanes
        ? "timeline"
        : "text"
      : scriptFocus
        ? "text"
        : "timeline",
  );

  const phone = arrangement === "phone";
  // Memoized: a new element would re-render the timeline it is slotted into.
  const headers = useMemo(
    () => (
      <TrackHeadersColumn
        showSoloChip={!phone}
        corner={phone ? undefined : <EditToolStrip />}
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

  const script = loadFailure ? (
    <Cover
      size="region"
      glyph="triangle-alert"
      title="Script could not load"
      primary={{ label: "Retry", onClick: loadFailure.onRetry }}
    >
      {loadFailure.message}
    </Cover>
  ) : loading ? (
    <Skeleton layout="list" />
  ) : (
    <div ref={scriptScroll} className="edit-script-body">
      <TranscriptPanel />
    </div>
  );

  const inspectorWanted =
    shell === "desktop" &&
    selection != null &&
    (!isRangeSelection(selection) || oneWordOf(selection) !== null);
  // A word drag grows the range past one word, which would drop the column
  // and slide the Script list out from under the pointer. The column holds
  // until the drag lets go.
  const heldInspector = useRef(inspectorWanted);
  const selectionDragging = useDawStore((s) => s.timelineDragging);
  if (!selectionDragging || inspectorWanted) {
    heldInspector.current = inspectorWanted;
  }
  const showInspector = selectionDragging
    ? heldInspector.current
    : inspectorWanted;
  const rangeActions =
    selectionSheet.rangeActionsInSheet || phone ? null : <RangeActions />;
  const corner = <EditCorner showScript={!phone} />;

  return (
    <EditWorkspaceView
      arrangement={arrangement}
      state={state}
      guest={guestShare}
      scriptHidden={scriptCollapsed}
      scriptFocus={scriptFocus}
      scriptWidthRem={size.widthRem}
      rangeActions={rangeActions}
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
      inspector={showInspector ? <Inspector /> : null}
      phone={
        <PhoneEditSurfaceView
          surface={editSurface}
          onSurfaceChange={setEditSurface}
          tools={<EditToolStrip />}
          corner={corner}
          lanes={timeline}
          script={script}
          bindings={{ lanes: timelineRegion, script: scriptRegion }}
          onOpenMix={
            canEditMix(projectPath, guestMode, shareCapabilities)
              ? () => setOpenSheet("mix")
              : undefined
          }
        />
      }
      sheet={
        sheetShell ? (
          <InspectorSheet
            sheet={selectionSheet}
            feedbackHostRef={feedbackHostRef}
          />
        ) : null
      }
      bindings={{
        timeline: timelineRegion,
        divider: dividerRegion,
        script: scriptRegion,
        inspector: inspectorRegion,
      }}
    />
  );
}

/**
 * The Edit stage host: the timeline with its headers, the Script pane, the
 * Inspector and the sheets that hang off them. Mounted by the frame as the
 * stage body when Edit is up; unmounting it cannot lose the view, because
 * `setStage` snapshots zoom and scroll before the swap.
 */
export const EditWorkspace = memo(EditWorkspaceAdapter);
