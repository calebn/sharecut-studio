import { memo, type RefCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../../hooks/useMediaQueryStore";
import { useTimelineFocusRegion } from "../../hooks/useTimelineFocusRegion";
import { useViewportClass } from "../../hooks/useViewportClass";
import { canEditMix, canIngestMedia } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { Cover } from "../../system/Cover";
import { Skeleton } from "../../system/Skeleton";
import { RangeFields } from "../../timeline/RangeFields";
import { TimelineView } from "../../timeline/TimelineView";
import { TrackHeadersColumn } from "../../tracks/TrackHeadersColumn";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { EditActionBar } from "./EditActionBar";
import { EditCorner } from "./EditCorner";
import { type EditArrangement, EditWorkspaceView } from "./EditWorkspaceView";
import { EmptySession } from "./EmptySession";
import { InspectorHost } from "./InspectorHost";
import { PhoneEditSurfaceView } from "./PhoneEditSurfaceView";
import { PlusMenu } from "./PlusMenu";
import { ScriptDivider } from "./ScriptDivider";
import { ScriptHost } from "./script/ScriptHost";
import { useAudioDrop } from "./useAudioDrop";
import { useInspectorOpen } from "./useInspectorOpen";
import { useScriptSize } from "./useScriptSize";

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
    scriptCollapsed,
    scriptFocus,
    editSurface,
    setOpenSheet,
    setTimelineFocused,
    projectPath,
    guestMode,
    shareCapabilities,
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

  const phone = arrangement === "phone";
  // Memoized: a new element would re-render the timeline it is slotted into.
  const headers = useMemo(
    () => (
      <TrackHeadersColumn
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
  const script = loadFailure ? (
    <section aria-label="Script" className="edit-script-state">
      <Cover
        size="region"
        glyph="triangle-alert"
        title="Script could not load"
        primary={{ label: "Retry", onClick: loadFailure.onRetry }}
      >
        {loadFailure.message}
      </Cover>
    </section>
  ) : loading ? (
    <section aria-label="Script" className="edit-script-state">
      <Skeleton layout="list" />
    </section>
  ) : (
    <div ref={scriptScroll} className="edit-script-body">
      <ScriptHost
        key={projectPath ?? ""}
        layout={phone ? "phone" : "desktop"}
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
  const corner = <EditCorner showScript={!phone} />;

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
      phone={
        <PhoneEditSurfaceView
          surface={editSurface}
          onSurfaceChange={(surface) =>
            runPointerCommand("stage.edit", { surface })
          }
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
        <InspectorHost
          shell={shell}
          sheet={inspector}
          root={root}
          regionRef={inspectorRegion}
          feedbackHostRef={feedbackHostRef}
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
