import { useRef, useState } from "react";
import {
  canIngestMedia,
  isShareProjectKey,
  rangeEditMode,
} from "../../../shareMode";
import { FindBar, type FindBarHandle } from "../../../stages/edit/FindBar";
import { SpeakerPopover } from "../../../stages/edit/SpeakerPopover";
import { useDawStore } from "../../../state/dawStore";
import { ScriptPane, type ScriptPaneHandle } from "../../../system/ScriptPane";
import type { ScriptStatus } from "../../../system/scriptPieces";
import { useScriptFind } from "./useScriptFind";
import { useScriptFixText } from "./useScriptFixText";
import { useScriptModel } from "./useScriptModel";
import { useScriptPlayback } from "./useScriptPlayback";
import { useScriptSelection } from "./useScriptSelection";
import { useScriptSpeaker } from "./useScriptSpeaker";
import { useScriptUnsure } from "./useScriptUnsure";
import { useScriptWindow } from "./useScriptWindow";

export type ScriptHostProps = {
  /** Where the Script is drawn. Left out, it follows the shell. */
  layout?: "desktop" | "phone";
  /**
   * The Script's state when the store cannot tell: transcribing and out of
   * date have no store source yet. Left out, the host reads the store: words
   * still loading, no words, or ready.
   */
  status?: ScriptStatus;
  /** The empty state's "Transcribe this episode". */
  onTranscribe?: () => void;
};

const NOTHING = () => {};

function guestLabel(
  projectPath: string,
  guestMode: string | null,
  mode: ReturnType<typeof rangeEditMode>,
): "viewer" | "commenter" | undefined {
  if (!isShareProjectKey(projectPath) && guestMode === null) return undefined;
  if (guestMode === "view") return "viewer";
  if (guestMode === "comment") return "commenter";
  if (mode === "edit") return undefined;
  return mode === "suggest" ? "commenter" : "viewer";
}

/**
 * The Script: the project's transcript read, selected, fixed and searched
 * through the Script pane. It reads the store, builds the model and writes
 * the store only from handlers. What a person may do is set by which
 * callbacks the pane is given: the pane's `guest` label only names the role.
 * Nothing mounts it yet.
 */
export function ScriptHost({
  layout: layoutProp,
  status: statusProp,
  onTranscribe = NOTHING,
}: ScriptHostProps) {
  const projectPath = useDawStore((s) => s.projectPath);
  const guestMode = useDawStore((s) => s.guestMode);
  const capabilities = useDawStore((s) => s.shareCapabilities);
  const breakpoint = useDawStore((s) => s.shellBreakpoint);
  const loading = useDawStore(
    (s) => s.project?.meta.hydration?.transcript_words === false,
  );
  const showCut = useDawStore((s) => s.showCutAwayUtterances);

  const hostEditable = !isShareProjectKey(projectPath);
  const mode = rangeEditMode(projectPath, capabilities);
  const { model, texts, silent, unsure, hasWords } = useScriptModel();
  const status: ScriptStatus =
    statusProp ??
    (loading
      ? { kind: "loading" }
      : hasWords
        ? { kind: "ready" }
        : { kind: "empty", onTranscribe });
  const ready = status.kind !== "loading" && status.kind !== "empty";

  const pane = useRef<ScriptPaneHandle>(null);
  const hostEl = useRef<HTMLDivElement>(null);
  const bar = useRef<FindBarHandle>(null);
  const [said, setSaid] = useState("");
  const say = (message: string) => setSaid(message);

  const playback = useScriptPlayback(model, silent);
  const win = useScriptWindow(model, pane, hostEl, playback, undefined);
  const selection = useScriptSelection(model, mode !== "none", win.reached);
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
  const speaker = useScriptSpeaker(
    model,
    canIngestMedia(projectPath, guestMode, capabilities) && ready,
    say,
  );

  const phone =
    (layoutProp ?? (breakpoint === "phone" ? "phone" : "desktop")) === "phone";
  const mayReplace = hostEditable && loading !== true;

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
        carets={selection.carets}
        matches={find.matches}
        currentMatch={find.current}
        findStatus={find.status}
        editing={fix.editing}
        renderEditor={fix.renderEditor}
        showCutText={showCut}
        following={playback.following}
        guest={guestLabel(projectPath, guestMode, mode)}
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
              replace={
                mayReplace
                  ? {
                      open: find.replaceOpen,
                      onOpenChange: find.setReplaceOpen,
                      text: find.replaceText,
                      onTextChange: find.setReplaceText,
                      onReplace: find.replaceOne,
                      onReplaceAll: find.replaceAll,
                    }
                  : undefined
              }
              returnFocus={() => pane.current?.focusFind()}
            />
          ) : null
        }
        onCaret={selection.onCaret}
        onSelect={selection.onSelect}
        onClearSelection={selection.onClearSelection}
        onFixText={fix.onFixText}
        onSeek={playback.onSeek}
        onSeekTurn={playback.onSeekTurn}
        onSpeaker={speaker.onSpeaker}
        onFind={find.openBar}
        onNextUnsure={mode === "none" ? undefined : jump}
        onShowCutTextChange={(show) =>
          useDawStore.getState().setShowCutAwayUtterances(show)
        }
        onFollowChange={playback.onFollowChange}
        onBackToPlayhead={() => {
          playback.onFollowChange(true);
          const word = playback.playing[0] ?? playback.playheadWord;
          if (word !== undefined) win.scrollTo(word, "center");
        }}
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
