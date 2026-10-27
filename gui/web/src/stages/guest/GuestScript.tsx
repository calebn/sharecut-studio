import { useRef, useState } from "react";
import { Cover } from "../../system/Cover";
import { ScriptPane, type ScriptPaneHandle } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";
import { lastIndexAtOrBefore } from "../../utils/math";
import type { GuestRole } from "./guestLogic";

export type GuestScriptProps = {
  access: GuestRole;
  layout: "desktop" | "phone";
  turns: readonly ScriptTurn[];
  /** Start second of each word, by word index, ascending. */
  wordStarts: readonly number[];
  /** Playhead in seconds; the Script follows it until the guest scrolls away. */
  playhead: number;
  onSeek: (seconds: number) => void;
  onUserScroll?: () => void;
};

export function GuestScript({
  access,
  layout,
  turns,
  wordStarts,
  playhead,
  onSeek,
  onUserScroll,
}: GuestScriptProps) {
  const [following, setFollowing] = useState(true);
  const pane = useRef<ScriptPaneHandle>(null);
  const word = lastIndexAtOrBefore(wordStarts, playhead);
  if (turns.length === 0) {
    return (
      <Cover size="region" glyph="inbox" title="Nothing to read yet">
        The host has not made a transcript of this version.
      </Cover>
    );
  }
  return (
    <ScriptPane
      ref={pane}
      turns={turns}
      layout={layout}
      guest={access === "viewer" ? "viewer" : "commenter"}
      playing={word}
      following={following}
      onSeek={(index) => onSeek(wordStarts[index] ?? playhead)}
      onUserScroll={() => {
        setFollowing(false);
        onUserScroll?.();
      }}
      onBackToPlayhead={() => {
        setFollowing(true);
        if (word !== undefined) pane.current?.scrollToWord(word, "center");
      }}
      onFollowChange={setFollowing}
    />
  );
}
