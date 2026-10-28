import { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import { useViewportClass } from "../../hooks/useViewportClass";
import { GuestScript } from "../../stages/guest/GuestScript";
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
  const role = stageRoleOf(guestMode);
  const { turns, wordStarts, words } = useMemo(
    () => guestScriptOf(utterances),
    [utterances],
  );
  const playingKey = useDawStore(
    useCallback(
      (s: { playheadSec: number }) =>
        playingWordsAt(words, s.playheadSec).join(","),
      [words],
    ),
  );
  const playing = useMemo(
    () => (playingKey === "" ? [] : playingKey.split(",").map(Number)),
    [playingKey],
  );
  if (role === "host") return null;
  return (
    <div className="stage-host-guest-script">
      <GuestScript
        access={role}
        layout={shell === "phone" ? "phone" : "desktop"}
        turns={turns}
        wordStarts={wordStarts}
        playing={playing}
        hasTranscript={(utterances?.length ?? 0) > 0}
        onSeek={(seconds) => void seekTransport(seconds)}
      />
    </div>
  );
}

export const GuestScriptHost = memo(GuestScriptHostAdapter);
