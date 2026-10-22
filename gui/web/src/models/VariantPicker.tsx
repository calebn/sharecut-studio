import { Field } from "../ui";
import type { ModelView } from "./types";
import { useModels } from "./useModels";

/**
 * The size picker for the model whose variant is one of the catalog's (Whisper). It renders nothing
 * for any other row, so no caller names a model id. Choosing refetches status for that size.
 */
export function VariantPicker({
  model,
  disabled = false,
}: {
  model: ModelView;
  disabled?: boolean;
}) {
  const { whisper } = useModels();
  if (
    model.variant === null ||
    !whisper.variants.some((v) => v.id === model.variant)
  ) {
    return null;
  }
  const chosen = whisper.variants.find((v) => v.id === whisper.variant);
  return (
    <Field
      label={`${model.label} size`}
      hint={chosen ? `${chosen.size}. ${chosen.description}` : undefined}
    >
      {(control) => (
        <select
          {...control}
          value={whisper.variant}
          disabled={disabled}
          onChange={(e) => whisper.choose(e.target.value)}
        >
          {whisper.variants.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label} ({opt.size})
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
