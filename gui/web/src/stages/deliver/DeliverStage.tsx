import { useEffect, useRef, useState } from "react";
import { Cover } from "../../system/Cover";
import type { LinkCopyState } from "../../system/LinkRow";
import { Player } from "../../system/Player";
import { Skeleton } from "../../system/Skeleton";
import { type StageId, VERBS } from "../../system/verbs";
import { Toast, type ToastState } from "../../ui";
import { isApplePlatform } from "../../utils/platform";
import { ChaptersList } from "./ChaptersList";
import { ClipsRow } from "./ClipsRow";
import type { ClipWord } from "./clipTrim";
import {
  addChapterAt,
  approveClip,
  type Chapter,
  type Clip,
  currentExportState,
  type DeliverEnv,
  type EpisodeSettings,
  type ExportFile,
  type ExportRequest,
  type ExportState,
  exportBlocker,
  exportRequest,
  primaryAction,
  type ReadinessFacts,
  readinessRows,
  removeChapter,
  removeClip,
  restoreChapter,
  restoreClip,
  retimeChapter,
  retitleChapter,
  retitleClip,
  type TimeSpan,
  trimClip,
  validSelection,
} from "./deliverLogic";
import { EpisodeFile } from "./EpisodeFile";
import { ExportButton } from "./ExportButton";
import { ListenLink } from "./ListenLink";
import { Readiness } from "./Readiness";
import { useFocusRecovery } from "./useFocusRecovery";

export type DeliverStageProps = {
  facts: ReadinessFacts;
  /** Episode length in seconds. */
  total: number;
  initialSettings: EpisodeSettings;
  initialChapters: readonly Chapter[];
  initialClips: readonly Clip[];
  saveTo: string;
  exportState: ExportState;
  env?: DeliverEnv;
  clock: { time: string; total: string };
  /** Playhead in seconds, where Add at playhead puts a chapter. */
  playhead: number;
  /** A range selected in Edit; Mod+E exports it instead of the Deliver In and Out. */
  selection?: TimeSpan | null;
  /** Episode words in seconds, sorted by start; clip trim handles snap to them. Without them the handles move freely. */
  words?: readonly ClipWord[];
  /** Peaks spread evenly over the episode, 0 to 1, for the clip trim strip. */
  peaks?: readonly number[];
  link: {
    url: string | null;
    copyState?: LinkCopyState;
    openedBy?: readonly { name: string; colorIndex?: number }[];
    noMix?: boolean;
    /** `network`: only people on this network can open the link. */
    reach?: "anywhere" | "network";
  };
  /** The exported version the listen link is pinned to. */
  pinnedTo: string;
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  /** Guests get Review only; Deliver shows a Cover instead of controls. */
  guest?: boolean;
  toastMs?: number;
  onFix: (stage: StageId, target?: string) => void;
  onExport: (request: ExportRequest) => void;
  onCancel: () => void;
  onReveal: (file?: ExportFile) => void;
  onDownload: (file?: ExportFile) => void;
  onChangeFolder: () => void;
  onCopyLink: () => void;
  onRefreshMix: () => void;
  onPlayFrom: (seconds: number) => void;
  onPlayClip: (id: string) => void;
  onFindClips: () => void;
  onOpenClipInEdit: (id: string) => void;
  onGetModel?: () => void;
  onRetry?: () => void;
};

const EXPORT_KEY = VERBS.find((verb) => verb.id === "export")?.keys[0];

let nextChapter = 0;

const IN_FLIGHT_MS = 2000;

export function DeliverStage({
  facts,
  total,
  initialSettings,
  initialChapters,
  initialClips,
  saveTo,
  exportState,
  env = "app",
  clock,
  playhead,
  selection = null,
  words,
  peaks,
  link,
  pinnedTo,
  layout = "desktop",
  state = "ready",
  guest = false,
  toastMs = 6000,
  onFix,
  onExport,
  onCancel,
  onReveal,
  onDownload,
  onChangeFolder,
  onCopyLink,
  onRefreshMix,
  onPlayFrom,
  onPlayClip,
  onFindClips,
  onOpenClipInEdit,
  onGetModel,
  onRetry,
}: DeliverStageProps) {
  const [settings, setSettings] = useState(initialSettings);
  const [chapters, setChapters] = useState<readonly Chapter[]>(initialChapters);
  const [clips, setClips] = useState<readonly Clip[]>(initialClips);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const phone = layout === "phone";
  const loading = state === "loading";

  const blocker = loading
    ? "Still loading."
    : exportBlocker(settings, exportState);
  const pick = validSelection(selection, total);
  const request = exportRequest(settings, clips, chapters);
  const keyRequest = exportRequest(settings, clips, chapters, pick);
  const shownState = currentExportState(exportState, request, keyRequest);
  const action = primaryAction(shownState, env);

  const release = useRef<number | null>(null);
  const clearInFlight = () => {
    inFlight.current = false;
    if (release.current !== null) window.clearTimeout(release.current);
    release.current = null;
  };
  useEffect(() => {
    clearInFlight();
  }, [exportState]);
  useEffect(() => clearInFlight, []);
  const startExport = (viaKey = false) => {
    if (guest || blocker || action === "exporting" || inFlight.current) return;
    inFlight.current = true;
    release.current = window.setTimeout(clearInFlight, IN_FLIGHT_MS);
    onExport(viaKey ? keyRequest : request);
  };
  const onKey = useRef(startExport);
  useEffect(() => {
    onKey.current = startExport;
  });
  useEffect(() => {
    if (!rootEl || !EXPORT_KEY) return;
    const listener = (event: KeyboardEvent) => {
      if (
        (isApplePlatform()
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        event.key.toUpperCase() === EXPORT_KEY.key
      ) {
        event.preventDefault();
        onKey.current(true);
      }
    };
    rootEl.addEventListener("keydown", listener);
    return () => rootEl.removeEventListener("keydown", listener);
  }, [rootEl]);
  useFocusRecovery(rootEl);

  if (guest) {
    return (
      <div className="dv-stage" data-layout={layout}>
        <Cover size="region" glyph="eye-off" title="Only the host can deliver">
          You can listen and comment in Review.
        </Cover>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="dv-stage" data-layout={layout}>
        <Cover
          size="region"
          glyph="octagon-alert"
          title="Could not load Deliver"
          primary={
            onRetry ? { label: "Try again", onClick: onRetry } : undefined
          }
        >
          Your edits are saved.
        </Cover>
      </div>
    );
  }

  const rows = readinessRows(facts);
  const notify = (message: string, onUndo: () => void) => {
    setToast({ id: Date.now(), message });
    setUndo(() => () => {
      onUndo();
      setToast(null);
    });
  };
  const removeChapterWithUndo = (id: string) => {
    const gone = chapters.find((c) => c.id === id);
    if (!gone) return;
    setChapters((now) => removeChapter(now, id));
    notify(`Removed ${gone.title}`, () =>
      setChapters((now) => restoreChapter(now, gone)),
    );
  };
  const removeClipWithUndo = (id: string) => {
    const index = clips.findIndex((c) => c.id === id);
    const gone = clips[index];
    if (!gone) return;
    setClips((now) => removeClip(now, id));
    notify(`Removed ${gone.title}`, () =>
      setClips((now) => restoreClip(now, gone, index)),
    );
  };
  const sharedState = loading ? "loading" : "ready";
  const chaptersPart = (
    <ChaptersList
      chapters={chapters}
      total={total}
      state={sharedState}
      onRetitle={(id, title) =>
        setChapters((now) => retitleChapter(now, id, title))
      }
      onRetime={(id, at) => setChapters((now) => retimeChapter(now, id, at))}
      onPlayFrom={onPlayFrom}
      onRemove={removeChapterWithUndo}
      onAdd={() =>
        setChapters((now) =>
          addChapterAt(now, Math.min(playhead, total), `new-${nextChapter++}`),
        )
      }
    />
  );
  const clipsPart = (
    <ClipsRow
      clips={clips}
      total={total}
      state={sharedState}
      words={words}
      peaks={peaks}
      onRetitle={(id, title) => setClips((now) => retitleClip(now, id, title))}
      onTrim={(id, edge, at) =>
        setClips((now) => trimClip(now, id, edge, at, total))
      }
      onPlay={onPlayClip}
      onApprove={(id) => setClips((now) => approveClip(now, id))}
      onRemove={removeClipWithUndo}
      onOpenInEdit={onOpenClipInEdit}
      onFind={onFindClips}
    />
  );

  return (
    <div
      ref={setRootEl}
      className="dv-stage"
      data-layout={layout}
      tabIndex={-1}
    >
      <section
        className="dv-page"
        aria-label="Deliver"
        aria-busy={loading || undefined}
      >
        <Readiness rows={rows} state={sharedState} onFix={onFix} />
        <div className="dv-columns">
          <div className="dv-col">
            <EpisodeFile
              settings={settings}
              total={total}
              saveTo={saveTo}
              exportState={shownState}
              env={env}
              state={sharedState}
              dock={phone}
              onSettings={setSettings}
              onChangeFolder={onChangeFolder}
              onExport={() => startExport()}
              onGetModel={onGetModel}
              onCancel={onCancel}
              onReveal={onReveal}
              onDownload={onDownload}
            />
            {phone ? null : (
              <>
                {chaptersPart}
                {clipsPart}
              </>
            )}
          </div>
          <div className="dv-col">
            {state === "loading" ? (
              <Skeleton layout="list" rows={2} />
            ) : (
              <ListenLink
                pinnedTo={pinnedTo}
                link={link.url}
                copyState={link.copyState}
                openedBy={link.openedBy}
                reach={link.reach}
                noMix={link.noMix ? { onRefresh: onRefreshMix } : undefined}
                share={phone}
                compact={phone}
                highlight={shownState.phase === "done"}
                onCopy={onCopyLink}
              />
            )}
          </div>
        </div>
        {phone ? (
          <>
            {chaptersPart}
            {clipsPart}
          </>
        ) : null}
      </section>
      <div className="dv-foot">
        {phone ? (
          <ExportButton
            action={action}
            blocker={blocker}
            onExport={() => startExport()}
            onReveal={() => onReveal()}
            onDownload={() => onDownload()}
          />
        ) : null}
        <Toast
          className="sys-toast-dock"
          toast={toast}
          timeoutMs={toastMs}
          onUndo={undo ?? undefined}
          onDismiss={() => setToast(null)}
        />
        <Player
          form="bar"
          playing={playing}
          time={clock.time}
          total={clock.total}
          onPlayPause={() => setPlaying(!playing)}
        />
      </div>
    </div>
  );
}
