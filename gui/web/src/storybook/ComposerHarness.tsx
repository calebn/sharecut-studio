import { useRef, useState } from "react";
import { Composer, type ComposerProps } from "../system/Composer";
import {
  idleAnchor,
  nextAnchor,
  type Playhead,
} from "../system/composerAnchor";

type HarnessProps = Partial<ComposerProps> & { start?: string };

/** The playhead every story shares: 12:04. */
const STORY_PLAYHEAD: Playhead = { seconds: 724 };

/**
 * A Composer that owns its text and anchor and applies `nextAnchor` against a
 * fixed playhead, as the Review host does. The chip follows the playhead until
 * the first keystroke pins it; emptying a typed pin follows again, and so does a
 * post, whichever anchor the story started from.
 */
export function ComposerHarness({
  start = "",
  anchor: initialAnchor = idleAnchor(STORY_PLAYHEAD),
  name: initialName,
  onSubmit,
  onAnchor,
  onBodyChange,
  ...rest
}: HarnessProps) {
  const [body, setBody] = useState(start);
  const [anchor, setAnchor] = useState(initialAnchor);
  const [name, setName] = useState(initialName?.value ?? "");
  const typedPin = useRef(false);
  return (
    <Composer
      {...rest}
      body={body}
      onBodyChange={(value, edit) => {
        onBodyChange?.(value, edit);
        if (!value && !edit?.composing && typedPin.current) {
          typedPin.current = false;
          setAnchor(idleAnchor(STORY_PLAYHEAD));
        }
        setBody(value);
      }}
      onSubmit={() => {
        onSubmit?.();
        typedPin.current = false;
        setBody("");
        setAnchor(idleAnchor(STORY_PLAYHEAD));
      }}
      anchor={anchor}
      onAnchor={(intent) => {
        onAnchor?.(intent);
        typedPin.current = intent === "pin" && anchor.kind === "follow";
        setAnchor((a) => nextAnchor(a, intent, STORY_PLAYHEAD));
      }}
      name={
        initialName
          ? {
              ...initialName,
              value: name,
              onChange: (value) => {
                initialName.onChange(value);
                setName(value);
              },
            }
          : undefined
      }
    />
  );
}

/** The 360 px column a phone story renders in. */
export function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        inlineSize: "22.5rem",
        maxInlineSize: "100%",
        padding: "var(--space-4)",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}
