import { SegmentedControl, ToggleButton } from "../ui";
import { plainSize, WHISPER_SIZES } from "./capability";
import { useModels } from "./useModels";

/**
 * Fast, Balanced or Best for the transcription model, each with its download size. Choosing one
 * only picks the size: the row above it then says "Not installed" with Get, and nothing opens.
 */
export function WhisperSize({ disabled = false }: { disabled?: boolean }) {
  const { whisper } = useModels();
  return (
    <SegmentedControl label="Size">
      {WHISPER_SIZES.map((option) => {
        const listed = whisper.variants.find((v) => v.id === option.id);
        const size = listed ? plainSize(listed.size) : option.size;
        return (
          <ToggleButton
            key={option.id}
            pressed={whisper.variant === option.id}
            disabledReason={
              disabled ? "Another download is running" : undefined
            }
            onClick={() => whisper.choose(option.id)}
          >
            {option.name} ({size})
          </ToggleButton>
        );
      })}
    </SegmentedControl>
  );
}
