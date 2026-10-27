import { useState } from "react";
import { Composer, type ComposerProps } from "../system/Composer";

type HarnessProps = Partial<ComposerProps> & { start?: string };

/** A Composer that owns its text and pins its time on the first keystroke, as the host will. */
export function ComposerHarness({
  start = "",
  time: initialTime,
  name: initialName,
  onSubmit,
  onPinTime,
  onUnpinTime,
  ...rest
}: HarnessProps) {
  const [body, setBody] = useState(start);
  const [time, setTime] = useState(initialTime);
  const [name, setName] = useState(initialName?.value ?? "");
  return (
    <Composer
      {...rest}
      body={body}
      onBodyChange={setBody}
      onSubmit={() => {
        onSubmit?.();
        setBody("");
      }}
      time={time}
      onPinTime={() => {
        onPinTime?.();
        setTime((t) => (t ? { ...t, pinned: true } : t));
      }}
      onUnpinTime={() => {
        onUnpinTime?.();
        setTime((t) => (t ? { ...t, pinned: false } : t));
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
