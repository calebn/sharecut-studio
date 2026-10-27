import { useState } from "react";
import { Composer } from "../../system/Composer";
import {
  type AnchorIntent,
  type AnchorSpan,
  anchorSpan,
  type ComposerAnchor,
  nextAnchor,
} from "../../system/composerAnchor";
import { capCommentName, GUEST_SESSION_LABEL } from "../../utils/commentAuthor";

/** `at` is absent for a whole-episode note. */
export type GuestPost = { body: string; at?: AnchorSpan; name: string };

type Props = {
  playhead: number;
  /** The guest's first comment shows a name field; blank posts as Guest. */
  firstPost: boolean;
  online: boolean;
  posting: boolean;
  compact: boolean;
  onPost: (post: GuestPost) => void;
};

export function GuestCompose({
  playhead,
  firstPost,
  online,
  posting,
  compact,
  onPost,
}: Props) {
  const [body, setBody] = useState("");
  const [held, setHeld] = useState<ComposerAnchor | null>(null);
  const [name, setName] = useState("");
  const anchor: ComposerAnchor = held ?? { kind: "follow", seconds: playhead };
  const onAnchor = (intent: AnchorIntent) =>
    setHeld(nextAnchor(anchor, intent, { seconds: playhead }));
  return (
    <Composer
      body={body}
      onBodyChange={setBody}
      anchor={anchor}
      onAnchor={onAnchor}
      name={firstPost ? { value: name, onChange: setName } : undefined}
      state={posting ? "posting" : online ? "idle" : "offline"}
      compact={compact}
      onSubmit={() => {
        const at = anchorSpan(anchor);
        onPost({
          body: body.trim(),
          ...(at ? { at } : {}),
          name: capCommentName(name) || GUEST_SESSION_LABEL,
        });
        setBody("");
        setHeld(null);
      }}
    />
  );
}
