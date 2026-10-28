import { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useViewportClass } from "../../hooks/useViewportClass";
import { GuestScript } from "../../stages/guest/GuestScript";
import { lastStartedWordAt } from "../../stages/guest/guestLogic";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { guestScriptOf, playingWordsAt } from "./guestScript";

function GuestScriptHostAdapter() {
  const { utterances, guestMode } = useDawStore(
    useShallow((s) => ({
      utterances: s.project?.transcript?.utterances,
      guestMode: s.guestMode,
    })),
  );
  const shell = useViewportClass();
  const short = useShortViewport();
  const role = stageRoleOf(guestMode);
  const { turns, wordStarts, words, empty } = useMemo(
    () => guestScriptOf(utterances),
    [utterances],
  );
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
  if (role === "host" || short) return null;
  return (
    <div className="stage-host-guest-script">
      <GuestScript
        access={role}
        layout={shell === "phone" ? "phone" : "desktop"}
        turns={turns}
        wordStarts={wordStarts}
        playing={playing}
        playheadWord={playheadWord}
        empty={empty}
        onSeek={(seconds) => void seekTransport(seconds)}
      />
    </div>
  );
}

export const GuestScriptHost = memo(GuestScriptHostAdapter);
