import { useId } from "react";
import { SegmentedControl, ToggleButton } from "../ui";
import { whisperSizeOptions } from "./capability";
import { useModels } from "./useModels";

export function WhisperSize({ disabled = false }: { disabled?: boolean }) {
  const { whisper } = useModels();
  const options = whisperSizeOptions(whisper.variants, whisper.engine);
  const noteId = useId();
  const note = options.find(
    (option) => option.id === whisper.variant,
  )?.description;
  return (
    <>
      <SegmentedControl label="Size" describedBy={note ? noteId : undefined}>
        {options.map((option) => (
          <ToggleButton
            key={option.id}
            pressed={whisper.variant === option.id}
            disabledReason={
              disabled ? "Another download is running" : undefined
            }
            onClick={() => whisper.choose(option.id)}
          >
            <span className="sys-size-name">{option.name}</span>{" "}
            <span className="sys-size-bytes">{option.size}</span>
          </ToggleButton>
        ))}
      </SegmentedControl>
      {note ? (
        <p id={noteId} className="sys-size-note">
          {note}
        </p>
      ) : null}
    </>
  );
}
