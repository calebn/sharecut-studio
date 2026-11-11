import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Cover } from "../../system/Cover";
import { Player } from "../../system/Player";
import { Skeleton } from "../../system/Skeleton";
import { StageHandoff } from "../../system/StageHandoff";
import type { StageId } from "../../types/stage";
import { Toast, type ToastState } from "../../ui";
import { BounceSection } from "./BounceSection";
import type { BounceOptions } from "./bounceLogic";
import { ChaptersList } from "./ChaptersList";
import { ClipsRow } from "./ClipsRow";
import type { ClipWord } from "./clipTrim";
import { DeliverSection } from "./DeliverSection";
import {
  afterExportOf,
  type DeliverFiles,
  type NamedExportFiles,
} from "./deliverFiles";
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
  reviewHandoff,
  sentenceStarts,
  trimClip,
  unapproveClip,
} from "./deliverLogic";
import { EpisodeFile } from "./EpisodeFile";
import { ExportButton } from "./ExportButton";
import { Readiness } from "./Readiness";
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
  namedFiles?: NamedExportFiles;
  clock?: { time: string; total: string };
  /** Playhead in seconds, where Add at playhead puts a chapter. */
  getPlayheadSec: () => number;
  /** Episode words in seconds, sorted by start; clip trim handles snap to them. Without them the handles move freely. */
  words?: readonly ClipWord[];
  /** Peaks spread evenly over the episode, 0 to 1, for the clip trim strip. */
  peaks?: readonly number[];
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  /** Guests get Review only; Deliver shows a Cover instead of controls. */
  guest?: boolean;
  toastMs?: number;
  /** Each change to the chapters or clips, after the first values. */
  onChapters?: (chapters: readonly Chapter[]) => void;
  onClips?: (clips: readonly Clip[]) => void;
  /** False hides the Listen link section even when the host offers one. */
  showLink?: boolean;
  /** False when the app frame already carries the Player bar. */
  showPlayer?: boolean;
  exportOptions?: ExportOptions;
  /** Without it the Bounce section is not shown. */
  bounce?: BounceOptions;
  /** Without it the Transcript section is not shown. */
  transcript?: TranscriptOptions;
  /**
   * The host's Listen link row, in the Listen link section. It gets
   * `highlight` once an export is done, and `phone`. Without it the section is not shown.
   */
  listen?: (state: { highlight: boolean; phone: boolean }) => ReactNode;
  /** The Podcast listing section, mounted after the Listen link. Without it the section is not shown. */
  feed?: ReactNode;
  /** Called when Undo brings a removed clip back, so a host can take the removal back too. */
  onClipRestore?: (clip: Clip) => void;
  /** True when each clip title is saved as it is finished (Enter or leaving the field), not on every keystroke. */
  clipTitleCommit?: boolean;
  onFix: (stage: StageId, target?: string) => void;
  onExport: (request: ExportRequest) => void;
  onCancel?: () => void;
  /** Without it the Saves to line is not shown. */
  onChangeFolder?: () => void;
  onPlayFrom: (seconds: number) => void;
  onPlayClip: (id: string) => void;
  onFindClips: () => void;
  /** True while Find clips runs; the button reads unavailable with the reason. */
  findingClips?: boolean;
  onOpenClipInEdit: (id: string) => void;
  onRetry?: () => void;
};

let nextChapter = 0;

const NO_CLOCK = { time: "", total: "" };

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
  namedFiles,
  clock = NO_CLOCK,
  getPlayheadSec,
  words,
  peaks,
  layout = "desktop",
  state = "ready",
  guest = false,
  toastMs,
  showLink = true,
  showPlayer = true,
  exportOptions,
  bounce,
  transcript,
  listen,
  feed,
  onClipRestore,
  clipTitleCommit = false,
  onChapters,
  onClips,
  onFix,
  onExport,
  onCancel,
  onChangeFolder,
  onPlayFrom,
  onPlayClip,
  onFindClips,
  findingClips = false,
  onOpenClipInEdit,
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
  const starts = useMemo(() => sentenceStarts(words), [words]);

  const blocker = loading
    ? "Still loading."
    : exportBlocker(settings, exportState, exportOptions);
  const edits = exportOptions?.edits;
  const hostedLoudness = exportOptions?.loudness;
  const request = exportRequest(
    settings,
    clips,
    chapters,
    undefined,
    edits,
    hostedLoudness ? hostedLoudness.choice : undefined,
  );
  const shownState = currentExportState(exportState, request);
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
  const startExport = () => {
    if (guest || blocker || exporting || inFlight.current) return;
    inFlight.current = true;
    release.current = window.setTimeout(clearInFlight, IN_FLIGHT_MS);
    onExport(request);
  };
  const exportAgain = exportOptions?.onExportAgain;
  const exportAgainAndStart = exportAgain
    ? () => {
        if (blocker || exporting || inFlight.current) return;
        exportAgain();
        startExport();
      }
    : undefined;
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
  const handoff = reviewHandoff(facts);
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
    notify(`Removed ${gone.title}`, () => {
      setClips((now) => restoreClip(now, gone, index));
      onClipRestore?.(gone);
    });
  };
  const sharedState = loading ? "loading" : "ready";
  const transcriptPart = transcript ? (
    <TranscriptSection
      options={transcript}
      files={files}
      filesRunning={exporting}
      state={sharedState}
      compact={phone}
    />
  ) : null;
  const chaptersPart = (
    <ChaptersList
      chapters={chapters}
      total={total}
      sentenceStarts={starts}
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
      onRetitle={(id, title) => {
        liveClips.current = retitleClip(liveClips.current, id, title);
        setClips(liveClips.current);
      }}
      onTrim={(id, edge, at) => {
        liveClips.current = trimClip(liveClips.current, id, edge, at, total);
        setClips(liveClips.current);
      }}
      onPlay={onPlayClip}
      onApprove={(id) => {
        liveClips.current = approveClip(liveClips.current, id);
        setClips(liveClips.current);
      }}
      onUnapprove={(id) => {
        liveClips.current = unapproveClip(liveClips.current, id);
        setClips(liveClips.current);
      }}
      onRemove={removeClipWithUndo}
      onOpenInEdit={onOpenClipInEdit}
      onFind={onFindClips}
      finding={findingClips}
      onTrimGesture={setTrimming}
      commitTitles={clipTitleCommit}
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
              namedFiles={namedFiles}
              state={sharedState}
              dock={phone}
              hasTranscriptSection={Boolean(transcript)}
              options={
                exportOptions && {
                  ...exportOptions,
                  onExportAgain: exportAgainAndStart,
                }
              }
              onSettings={changeSettings}
              onChangeFolder={onChangeFolder}
              onExport={() => startExport()}
              onCancel={onCancel}
            />
            {bounce ? (
              <BounceSection options={bounce} state={sharedState} />
            ) : null}
            {phone ? null : (
              <>
                {chaptersPart}
                {clipsPart}
                {transcriptPart}
              </>
            )}
          </div>
          <div className="dv-col">
            {!showLink || !listen ? null : state === "loading" ? (
              <Skeleton layout="list" rows={2} />
            ) : (
              <DeliverSection title="Listen link">
                {listen({
                  highlight: shownState.phase === "done" && !namedFiles,
                  phone,
                })}
              </DeliverSection>
            )}
            {feed}
          </div>
        </div>
        {phone ? (
          <>
            {chaptersPart}
            {clipsPart}
            {transcriptPart}
          </>
        ) : null}
      </section>
      <div className="dv-foot">
        {phone ? (
          <ExportButton
            exporting={exporting}
            blocker={blocker}
            after={afterExportOf(
              namedFiles ? undefined : files,
              shownState.phase === "done" || shownState.phase === "running",
            )}
            onExport={() => startExport()}
          />
        ) : null}
        {handoff && !loading ? (
          <div className="dv-handoff">
            <StageHandoff
              stage="review"
              label={handoff.label}
              size={phone ? 48 : 40}
              keyHint={false}
              onActivate={() => onFix("review", handoff.target)}
            />
          </div>
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
