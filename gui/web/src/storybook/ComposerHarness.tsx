import { useState } from "react";
import { Composer, type ComposerProps } from "../system/Composer";
import {
  idleAnchor,
  nextAnchor,
  type Playhead,
} from "../system/composerAnchor";

type HarnessProps = Partial<ComposerProps> & { start?: string };

/** The playhead every story shares: 12:04. */
const STORY_PLAYHEAD: Playhead = { seconds: 724 };

/** A Composer that owns its text and anchor and applies `nextAnchor` against a fixed playhead, as the host will. */
export function ComposerHarness({
  start = "",
  anchor: initialAnchor,
  name: initialName,
  onSubmit,
  onAnchor,
  ...rest
}: HarnessProps) {
  const [body, setBody] = useState(start);
  const [anchor, setAnchor] = useState(initialAnchor);
  const [name, setName] = useState(initialName?.value ?? "");
  return (
    <Composer
      {...rest}
      body={body}
      onBodyChange={setBody}
      onSubmit={() => {
        onSubmit?.();
        setBody("");
        if (initialAnchor) setAnchor(idleAnchor(STORY_PLAYHEAD));
      }}
      anchor={anchor}
      onAnchor={(intent) => {
        onAnchor?.(intent);
        setAnchor((a) => a && nextAnchor(a, intent, STORY_PLAYHEAD));
      }}
      name={
        initialName
          ? { ...initialName, value: name, onChange: setName }
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
