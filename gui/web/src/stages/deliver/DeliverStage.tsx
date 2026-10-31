import { type ReactNode, useEffect, useRef, useState } from "react";
import { Cover } from "../../system/Cover";
import type { LinkCopyState } from "../../system/LinkRow";
import { Player } from "../../system/Player";
import { Skeleton } from "../../system/Skeleton";
import { VERBS } from "../../system/verbs";
import type { StageId } from "../../types/stage";
import { Toast, type ToastState } from "../../ui";
import { isApplePlatform } from "../../utils/platform";
import { BounceSection } from "./BounceSection";
import type { BounceOptions } from "./bounceLogic";
import { ChaptersList } from "./ChaptersList";
import { ClipsRow } from "./ClipsRow";
import type { ClipWord } from "./clipTrim";
import type { DeliverFiles } from "./deliverFiles";
import {
  addChapterAt,
  approveClip,
  type Chapter,
  type Clip,
  currentExportState,
  type EpisodeSettings,
  type ExportOptions,
  type ExportRequest,
  type ExportState,
  exportBlocker,
  exportRequest,
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
import { ShareSection } from "./ShareSection";
import type { ShareOptions } from "./shareLogic";
import { TranscriptSection } from "./TranscriptSection";
import type { TranscriptOptions } from "./transcriptLogic";
import { useFocusRecovery } from "./useFocusRecovery";
import { useWriteBack } from "./useWriteBack";

export type DeliverStageProps = {
  facts: ReadinessFacts;
  /** Episode length in seconds. */
  total: number;
  initialSettings: EpisodeSettings;
  initialChapters: readonly Chapter[];
  initialClips: readonly Clip[];
  saveTo?: string;
  exportState: ExportState;
  /** The files the export folder holds, shown as rows in the section that owns each. */
  files?: DeliverFiles;
  clock?: { time: string; total: string };
  /** Playhead in seconds, where Add at playhead puts a chapter. */
  getPlayheadSec: () => number;
  /** A range selected in Edit; Mod+E exports it instead of the Deliver In and Out. */
  selection?: TimeSpan | null;
  /** Episode words in seconds, sorted by start; clip trim handles snap to them. Without them the handles move freely. */
  words?: readonly ClipWord[];
  /** Peaks spread evenly over the episode, 0 to 1, for the clip trim strip. */
  peaks?: readonly number[];
  link?: {
    url: string | null;
    copyState?: LinkCopyState;
    openedBy?: readonly { name: string; colorIndex?: number }[];
    noMix?: boolean;
    /** `network`: only people on this network can open the link. */
    reach?: "anywhere" | "network";
  };
  /** The exported version the listen link is pinned to. */
  pinnedTo?: string;
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  /** Guests get Review only; Deliver shows a Cover instead of controls. */
  guest?: boolean;
  toastMs?: number;
  /** Each change to the chapters or clips, after the first values. */
  onChapters?: (chapters: readonly Chapter[]) => void;
  onClips?: (clips: readonly Clip[]) => void;
  /** Without it the Listen link section is not shown. */
  showLink?: boolean;
  /** False when the app frame already carries the Player bar. */
  showPlayer?: boolean;
  exportOptions?: ExportOptions;
  /** Without it the Bounce section is not shown. */
  bounce?: BounceOptions;
  /** Without it the Transcript section is not shown. */
  transcript?: TranscriptOptions;
  /** Without it the Share section is not shown, and the Listen link section stands in when `showLink` is on. */
  share?: ShareOptions;
  /** The Podcast listing section, mounted after Share. Without it the section is not shown. */
  feed?: ReactNode;
  /** False when the host cannot put a removed clip back into the project. */
  clipUndo?: boolean;
  /** False when the host cannot save a clip's title or approval. */
  showClipEdits?: boolean;
  onFix: (stage: StageId, target?: string) => void;
  onExport: (request: ExportRequest) => void;
  onCancel?: () => void;
  /** Without it the Saves to line is not shown. */
  onChangeFolder?: () => void;
  onCopyLink?: () => void;
  onRefreshMix?: () => void;
  onPlayFrom: (seconds: number) => void;
  onPlayClip: (id: string) => void;
  onFindClips: () => void;
  onOpenClipInEdit: (id: string) => void;
  onGetModel?: () => void;
  onRetry?: () => void;
};

const EXPORT_KEY = VERBS.find((verb) => verb.id === "export")?.keys[0];

let nextChapter = 0;

const NO_CLOCK = { time: "", total: "" };
const NO_LINK = { url: null };

const IN_FLIGHT_MS = 2000;

export function DeliverStage({
  facts,
  total,
  initialSettings,
  initialChapters,
  initialClips,
  saveTo,
  exportState,
  files,
  clock = NO_CLOCK,
  getPlayheadSec,
  selection = null,
  words,
  peaks,
  link = NO_LINK,
  pinnedTo = "",
  layout = "desktop",
  state = "ready",
  guest = false,
  toastMs = 6000,
  showLink = true,
  showPlayer = true,
  exportOptions,
  bounce,
  transcript,
  share,
  feed,
  clipUndo = true,
  showClipEdits = true,
  onChapters,
  onClips,
  onFix,
  onExport,
  onCancel,
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
  const hostFormats = exportOptions?.selected;
  const hostKey = hostFormats?.join("\n");
  const [seenHostKey, setSeenHostKey] = useState(hostKey);
  if (hostKey !== seenHostKey) {
    setSeenHostKey(hostKey);
    if (hostFormats && hostKey !== settings.formats.join("\n")) {
      setSettings({ ...settings, formats: [...hostFormats] });
    }
  }
  const onFormats = exportOptions?.onFormats;
  const changeSettings = (next: EpisodeSettings) => {
    setSettings(next);
    if (next.formats.join("\n") !== settings.formats.join("\n"))
      onFormats?.(next.formats);
  };
  const [chapters, setChapters] = useState<readonly Chapter[]>(initialChapters);
  const [clips, setClips] = useState<readonly Clip[]>(initialClips);
  const liveChapters = useWriteBack(chapters, onChapters);
  const [trimming, setTrimming] = useState(false);
  const [settled, setSettled] = useState(clips);
  if (!trimming && settled !== clips) setSettled(clips);
  const liveClips = useWriteBack(settled, onClips, clips);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const phone = layout === "phone";
  const loading = state === "loading";

  const blocker = loading
    ? "Still loading."
    : exportBlocker(settings, exportState, exportOptions);
  const pick = validSelection(selection, total);
  const edits = exportOptions?.edits;
  const target = exportOptions?.target;
  const request = exportRequest(
    settings,
    clips,
    chapters,
    undefined,
    edits,
    target,
  );
  const keyRequest = exportRequest(
    settings,
    clips,
    chapters,
    pick,
    edits,
    target,
  );
  const shownState = currentExportState(exportState, request, keyRequest);
  const exporting = shownState.phase === "running";

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
    if (guest || blocker || exporting || inFlight.current) return;
    inFlight.current = true;
    release.current = window.setTimeout(clearInFlight, IN_FLIGHT_MS);
    onExport(viaKey ? keyRequest : request);
  };
  const exportAgain = exportOptions?.onExportAgain;
  const exportAgainAndStart = exportAgain
    ? () => {
        exportAgain();
        startExport();
      }
    : undefined;
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
  const notify = (message: string, onUndo?: () => void) => {
    setToast({ id: Date.now(), message });
    setUndo(
      onUndo
        ? () => () => {
            onUndo();
            setToast(null);
          }
        : null,
    );
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
    notify(
      `Removed ${gone.title}`,
      clipUndo
        ? () => setClips((now) => restoreClip(now, gone, index))
        : undefined,
    );
  };
  const sharedState = loading ? "loading" : "ready";
  const chaptersPart = (
    <ChaptersList
      chapters={chapters}
      total={total}
      state={sharedState}
      onRetitle={(id, title) => {
        liveChapters.current = retitleChapter(liveChapters.current, id, title);
        setChapters(liveChapters.current);
      }}
      onRetime={(id, at) => {
        liveChapters.current = retimeChapter(liveChapters.current, id, at);
        setChapters(liveChapters.current);
      }}
      onPlayFrom={onPlayFrom}
      onRemove={removeChapterWithUndo}
      onAdd={() =>
        setChapters((now) =>
          addChapterAt(
            now,
            Math.min(getPlayheadSec(), total),
            `new-${nextChapter++}`,
          ),
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
      onTrim={(id, edge, at) => {
        liveClips.current = trimClip(liveClips.current, id, edge, at, total);
        setClips(liveClips.current);
      }}
      onPlay={onPlayClip}
      onApprove={(id) => setClips((now) => approveClip(now, id))}
      onRemove={removeClipWithUndo}
      onOpenInEdit={onOpenClipInEdit}
      onFind={onFindClips}
      onTrimGesture={setTrimming}
      editable={showClipEdits}
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
              files={files}
              state={sharedState}
              dock={phone}
              transcriptKind={transcript?.preview.kind}
              options={
                exportOptions && {
                  ...exportOptions,
                  onExportAgain: exportAgainAndStart,
                }
              }
              onSettings={changeSettings}
              onChangeFolder={onChangeFolder}
              onExport={() => startExport()}
              onGetModel={onGetModel}
              onCancel={onCancel}
            />
            {transcript ? (
              <TranscriptSection
                options={transcript}
                files={files}
                filesRunning={exporting}
                state={sharedState}
                compact={phone}
              />
            ) : null}
            {bounce ? (
              <BounceSection options={bounce} state={sharedState} />
            ) : null}
            {phone ? null : (
              <>
                {chaptersPart}
                {clipsPart}
              </>
            )}
          </div>
          <div className="dv-col">
            {share ? (
              <ShareSection options={share} state={sharedState} />
            ) : !showLink ? null : state === "loading" ? (
              <Skeleton layout="list" rows={2} />
            ) : (
              <ListenLink
                pinnedTo={pinnedTo}
                link={link.url}
                copyState={link.copyState}
                openedBy={link.openedBy}
                reach={link.reach}
                noMix={
                  link.noMix ? { onRefresh: () => onRefreshMix?.() } : undefined
                }
                share={phone}
                compact={phone}
                highlight={shownState.phase === "done"}
                onCopy={() => onCopyLink?.()}
              />
            )}
            {feed}
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
            exporting={exporting}
            blocker={blocker}
            onExport={() => startExport()}
          />
        ) : null}
        <Toast
          className="sys-toast-dock"
          toast={toast}
          timeoutMs={toastMs}
          onUndo={undo ?? undefined}
          onDismiss={() => setToast(null)}
        />
        {showPlayer ? (
          <Player
            form="bar"
            playing={playing}
            time={clock.time}
            total={clock.total}
            onPlayPause={() => setPlaying(!playing)}
          />
        ) : null}
      </div>
    </div>
  );
}
