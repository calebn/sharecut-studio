import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useViewportClass } from "../../hooks/useViewportClass";
import { rangeEditMode } from "../../shareMode";
import { GuestScript } from "../../stages/guest/GuestScript";
import { lastStartedWordAt } from "../../stages/guest/guestLogic";
import {
  type GuestReading,
  useGuestReading,
} from "../../stages/guest/useGuestReading";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { isHostRole } from "../../utils/can";
import { scriptGuestOf } from "../edit/script/scriptGuest";
import { useScriptSelection } from "../edit/script/useScriptSelection";
import { GuestSelectionBar } from "./GuestSelectionBar";
import {
  guestScriptModelOf,
  guestScriptOf,
  playingWordsAt,
} from "./guestScript";

const NOOP = () => {};

export type GuestScriptHostProps = { reading?: GuestReading };

function GuestScriptHostAdapter({
  reading: providedReading,
}: GuestScriptHostProps) {
  const reading = useGuestReading(providedReading);
  const { utterances, guestMode, projectPath, capabilities } = useDawStore(
    useShallow((s) => ({
      utterances: s.project?.transcript?.utterances,
      guestMode: s.guestMode,
      projectPath: s.projectPath,
      capabilities: s.shareCapabilities,
    })),
  );
  const shell = useViewportClass();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const short = useShortViewport();
  const role = stageRoleOf(guestMode);
  const script = useMemo(() => guestScriptOf(utterances), [utterances]);
  const { turns, wordStarts, words, empty } = script;
  const rangeMode = rangeEditMode(projectPath, capabilities);
  const mayRange = rangeMode !== "none";
  const model = useMemo(() => guestScriptModelOf(script), [script]);
  const range = useScriptSelection(model, mayRange, NOOP);
  const positionKey = useDawStore(
    useCallback(
      (s: { playheadSec: number }) =>
        `${playingWordsAt(words, s.playheadSec).join(",")}|${lastStartedWordAt(wordStarts, s.playheadSec) ?? ""}`,
      [words, wordStarts],
    ),
  );
  const { playing, playheadWord } = useMemo(() => {
    const [now = "", last = ""] = positionKey.split("|");
    return {
      playing: now === "" ? [] : now.split(",").map(Number),
      playheadWord: last === "" ? undefined : Number(last),
    };
  }, [positionKey]);
  const hidden = isHostRole(role) ? false : short || !mayRange;
  const wasHidden = useRef(hidden);
  useEffect(() => {
    const turnedOff = hidden && !wasHidden.current;
    wasHidden.current = hidden;
    if (!turnedOff) return;
    const { selection, setSelection } = useDawStore.getState();
    if (selection?.kind === "transcriptRange" || selection?.kind === "range")
      setSelection(null);
  }, [hidden]);
  if (isHostRole(role) || short) return null;
  return (
    <div ref={setRoot} className="stage-host-guest-script">
      <GuestScript
        guest={scriptGuestOf(projectPath, guestMode, rangeMode)}
        layout={shell === "phone" ? "phone" : "desktop"}
        turns={turns}
        wordStarts={wordStarts}
        playing={playing}
        playheadWord={playheadWord}
        reading={reading}
        empty={empty}
        onSeek={(seconds) => void seekTransport(seconds)}
        selection={mayRange ? range.selection : undefined}
        onSelect={range.onSelect}
        onClearSelection={mayRange ? range.onClearSelection : undefined}
      />
      {mayRange ? (
        <GuestSelectionBar root={root} phone={shell === "phone"} />
      ) : null}
    </div>
  );
}

export const GuestScriptHost = memo(GuestScriptHostAdapter);
