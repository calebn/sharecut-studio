import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import { useViewportClass } from "../../hooks/useViewportClass";
import { GuestScript } from "../../stages/guest/GuestScript";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { guestScriptOf } from "./guestScript";

function GuestScriptHostAdapter() {
  const { utterances, guestMode } = useDawStore(
    useShallow((s) => ({
      utterances: s.project?.transcript?.utterances,
      guestMode: s.guestMode,
    })),
  );
  const playheadSec = useDawStore((s) => s.playheadSec);
  const shell = useViewportClass();
  const role = stageRoleOf(guestMode);
  const { turns, wordStarts } = useMemo(
    () => guestScriptOf(utterances ?? []),
    [utterances],
  );
  if (role === "host") return null;
  return (
    <div className="stage-host-guest-script">
      <GuestScript
        access={role}
        layout={shell === "phone" ? "phone" : "desktop"}
        turns={turns}
        wordStarts={wordStarts}
        playhead={playheadSec}
        onSeek={(seconds) => void seekTransport(seconds)}
      />
    </div>
  );
}

/**
 * A link's read-only Script, following the real playhead. Clicking a word
 * seeks the transport to it.
 */
export const GuestScriptHost = memo(GuestScriptHostAdapter);
