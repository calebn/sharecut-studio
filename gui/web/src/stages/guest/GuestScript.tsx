import { useRef, useState } from "react";
import { Cover } from "../../system/Cover";
import { ScriptPane, type ScriptPaneHandle } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";
import type { GuestRole } from "./guestLogic";

export type GuestScriptProps = {
  access: GuestRole;
  layout: "desktop" | "phone";
  turns: readonly ScriptTurn[];
  /** Start second of each word, by word index. */
  wordStarts: readonly number[];
  playing: number | readonly number[] | undefined;
  /** The transcript has words, but none is left for a guest to read. */
  hasTranscript?: boolean;
  onSeek: (seconds: number) => void;
  onUserScroll?: () => void;
};

export function GuestScript({
  access,
  layout,
  turns,
  wordStarts,
  playing,
  hasTranscript = false,
  onSeek,
  onUserScroll,
}: GuestScriptProps) {
  const [following, setFollowing] = useState(true);
  const pane = useRef<ScriptPaneHandle>(null);
  const first = typeof playing === "number" ? playing : playing?.[0];
  if (turns.length === 0) {
    return (
      <Cover size="region" glyph="inbox" title="Nothing to read yet">
        {hasTranscript
          ? "Every word of this version has been cut or ignored."
          : "The host has not made a transcript of this version."}
      </Cover>
    );
  }
  return (
    <ScriptPane
      ref={pane}
      turns={turns}
      layout={layout}
      guest={access === "viewer" ? "viewer" : "commenter"}
      playing={playing}
      following={following}
      onSeek={(index) => {
        const start = wordStarts[index];
        if (start !== undefined) onSeek(start);
      }}
      onUserScroll={() => {
        setFollowing(false);
        onUserScroll?.();
      }}
      onBackToPlayhead={() => {
        setFollowing(true);
        if (first !== undefined) pane.current?.scrollToWord(first, "center");
      }}
      onFollowChange={setFollowing}
    />
  );
}
