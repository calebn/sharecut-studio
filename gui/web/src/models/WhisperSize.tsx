import { SegmentedControl, ToggleButton } from "../ui";
import { plainSize, WHISPER_SIZES } from "./capability";
import { useModels } from "./useModels";

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
            aria-label={`${option.name} ${size}`}
          >
            <span className="sys-size-name">{option.name}</span>
            <span className="sys-size-bytes">{size}</span>
          </ToggleButton>
        );
      })}
    </SegmentedControl>
  );
}
