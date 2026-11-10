import { useEffect, useRef, useState } from "react";
import {
  canIngestMedia,
  isShareProjectKey,
  rangeEditMode,
} from "../../../shareMode";
import { FindBar, type FindBarHandle } from "../../../stages/edit/FindBar";
import { SpeakerPopover } from "../../../stages/edit/SpeakerPopover";
import { useDawStore } from "../../../state/dawStore";
import { playheadScrollRegistry } from "../../../state/playheadScrollRegistry";
import { ScriptPane, type ScriptPaneHandle } from "../../../system/ScriptPane";
import type {
  ScriptStatus,
  WordsSelection,
} from "../../../system/scriptPieces";
import { useCoachTip } from "../../../system/useCoachTip";
import { useStableCallback } from "../../../utils/useStableCallback";
import { scriptGuestOf } from "./scriptGuest";
import { useScriptCarets } from "./useScriptCarets";
import { useScriptFind } from "./useScriptFind";
import { useScriptFixText } from "./useScriptFixText";
import { useScriptModel } from "./useScriptModel";
import { useScriptPlayback } from "./useScriptPlayback";
import { useScriptSeamRoll } from "./useScriptSeamRoll";
import { useScriptSelection } from "./useScriptSelection";
import { useScriptSpeaker } from "./useScriptSpeaker";
import { selectTranscriptLoading, useScriptStatus } from "./useScriptStatus";
import { useScriptUnsure } from "./useScriptUnsure";
import { useScriptWindow } from "./useScriptWindow";

export type ScriptHostProps = {
  /** Where the Script is drawn. Left out, it follows the shell. */
  layout?: "desktop" | "phone";
  /** Out of date has no store source yet; every other state comes from the store. */
  status?: Extract<ScriptStatus, { kind: "outOfDate" }>;
  /** The empty state's "Transcribe this episode". */
  onTranscribe?: () => void;
};

/**
 * The Script: the project's transcript read, selected, fixed and searched
 * through the Script pane. It reads the store, builds the model and writes
 * the store only from handlers. What a person may do is set by which
 * callbacks the pane is given: the pane's `guest` label only names the role.
 */
export function ScriptHost({
  layout: layoutProp,
  status: statusProp,
  onTranscribe,
}: ScriptHostProps) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const stage = useDawStore((s) => s.stage);
  const pendingEditWordReveal = useDawStore((s) => s.pendingEditWordReveal);
  const guestMode = useDawStore((s) => s.guestMode);
  const capabilities = useDawStore((s) => s.shareCapabilities);
  const breakpoint = useDawStore((s) => s.shellBreakpoint);
  const loading = useDawStore(selectTranscriptLoading);
  const showCut = useDawStore((s) => s.showCutAwayUtterances);

  const hostEditable = !isShareProjectKey(projectPath);
  const mode = rangeEditMode(projectPath, capabilities);
  const { model, texts, silent, unsure, hasWords } = useScriptModel();
  const mayIngest = canIngestMedia(projectPath, guestMode, capabilities);
  // Only a person who may add media starts a transcription from the empty state.
  const transcribe = mayIngest ? onTranscribe : undefined;
  const derived = useScriptStatus(hasWords, transcribe);
  const status: ScriptStatus = statusProp ?? derived;
  // Words are written only while the Script shows settled words: not while
  // they load, are still being made, or no longer match the audio.
  const ready = status.kind === "ready";

  const pane = useRef<ScriptPaneHandle>(null);
  const hostEl = useRef<HTMLDivElement>(null);
  const bar = useRef<FindBarHandle>(null);
  const [said, setSaid] = useState("");
  const say = (message: string) => setSaid(message);

  const playback = useScriptPlayback(model, silent);
  const win = useScriptWindow(model, pane, hostEl, playback);
  const { scrollTo } = win;
  useEffect(() => {
    const request = pendingEditWordReveal;
    if (
      request === null ||
      stage !== "edit" ||
      !ready ||
      loading === true ||
      pane.current === null
    )
      return;
    const store = useDawStore.getState();
    if (
      store.pendingEditWordReveal !== request ||
      store.stage !== "edit" ||
      store.projectPath !== projectPath ||
      store.projectEpoch !== projectEpoch
    )
      return;
    const index = model.indexOf(request);
    if (index === undefined) {
      store.consumeEditWordReveal(request);
      return;
    }
    if (!store.consumeEditWordReveal(request)) return;
    scrollTo(index, "center");
    if (request.focus) pane.current?.focusWord(index);
  }, [
    loading,
    model,
    pendingEditWordReveal,
    projectEpoch,
    projectPath,
    ready,
    stage,
    scrollTo,
  ]);
  const selection = useScriptSelection(model, mode !== "none", win.reached);
  const handleTip = useCoachTip("selectionHandles");
  const onSelect = useStableCallback((next: WordsSelection) => {
    selection.onSelect?.(next);
    handleTip.show();
  });
  const carets = useScriptCarets(model, selection.carets);
  const jump = useScriptUnsure(model, texts, unsure, win.scrollTo, say);
  const fix = useScriptFixText(
    model,
    texts,
    pane,
    hostEditable && loading !== true && ready,
    say,
    jump,
  );
  const find = useScriptFind(model, bar, win.scrollTo, say);
  const seamRoll = useScriptSeamRoll(say);
  const speaker = useScriptSpeaker(model, mayIngest && ready, say);

  const backToPlayhead = () => {
    playback.onFollowChange(true);
    const word = playback.playing[0] ?? playback.playheadWord;
    if (word === undefined) return false;
    win.scrollTo(word, "center");
    return true;
  };
  useEffect(() => playheadScrollRegistry.register("script", backToPlayhead));

  const phone =
    (layoutProp ?? (breakpoint === "phone" ? "phone" : "desktop")) === "phone";
  const mayReplace = hostEditable && ready && loading !== true;
  const mayCut = mode === "edit" && ready && loading !== true;

  return (
    <div ref={hostEl} style={{ display: "contents" }}>
      <ScriptPane
        ref={pane}
        turns={win.turns}
        status={status}
        layout={phone ? "phone" : "desktop"}
        playing={playback.playing}
        playheadWord={playback.playheadWord}
        selection={selection.selection}
        carets={carets}
        matches={find.matches}
        currentMatch={find.current}
        findStatus={find.status}
        findStatusKey={find.statusKey}
        editing={fix.editing}
        renderEditor={fix.renderEditor}
        showCutText={showCut}
        following={playback.following}
        guest={scriptGuestOf(projectPath, guestMode, mode)}
        unsureCount={unsure.length}
        findBar={
          find.open ? (
            <FindBar
              ref={bar}
              query={find.query}
              onQueryChange={find.setQuery}
              caseSensitive={find.caseSensitive}
              onCaseSensitiveChange={find.setCaseSensitive}
              count={find.matches.length}
              current={find.current}
              onNext={find.next}
              onPrevious={find.previous}
              onClose={find.closeBar}
              onSelectAll={mode === "none" ? undefined : find.selectAll}
              onCutAll={mayCut ? find.cutAll : undefined}
              replace={
                mayReplace
                  ? {
                      open: find.replaceOpen,
                      onOpenChange: find.setReplaceOpen,
                      text: find.replaceText,
                      onTextChange: find.setReplaceText,
                      onReplace: find.replaceOne,
                      oneReason: find.replaceOneReason,
                      onReplaceAll: find.replaceAll,
                    }
                  : undefined
              }
              returnFocus={() => pane.current?.focusFind()}
            />
          ) : null
        }
        seamRoll={seamRoll}
        onCaret={selection.onCaret}
        onSelect={selection.onSelect && onSelect}
        handleHint={{
          text: handleTip.text,
          shown: handleTip.shown,
          onDismiss: handleTip.dismiss,
          onRelease: handleTip.release,
        }}
        onClearSelection={selection.onClearSelection}
        onSeamSelect={selection.onSeamSelect}
        onSuggestionSelect={selection.onSuggestionSelect}
        onFixText={fix.onFixText}
        onSeek={playback.onSeek}
        onSeekTurn={playback.onSeekTurn}
        onSpeaker={speaker.onSpeaker}
        onFind={find.openBar}
        onNextUnsure={mode === "none" ? undefined : () => jump()}
        onPreviousUnsure={
          mode === "none" ? undefined : () => jump(undefined, "previous")
        }
        onShowCutTextChange={(show) =>
          useDawStore.getState().setShowCutAwayUtterances(show)
        }
        onFollowChange={playback.onFollowChange}
        onBackToPlayhead={backToPlayhead}
        onUserScroll={playback.onUserScroll}
      />
      {speaker.open ? (
        <SpeakerPopover
          people={speaker.open.people}
          currentId={speaker.open.currentId}
          onPick={speaker.onPick}
          onRename={speaker.onRename}
          onClose={speaker.onClose}
          {...(phone
            ? { form: "bottom" as const, open: true }
            : { anchorRef: speaker.open.anchor })}
        />
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
    </div>
  );
}
