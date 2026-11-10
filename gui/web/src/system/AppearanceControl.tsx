import { type KeyboardEvent, useRef } from "react";
import { THEME_OPTIONS, type ThemePreference } from "../hooks/useTheme";
import { SegmentedControl, ToggleButton } from "../ui";

export type AppearanceValue = {
  value: ThemePreference;
  onChange: (preference: ThemePreference) => void;
};

/**
 * System / Light / Dark as one segmented control. `menu` renders the segments
 * as `menuitemradio` rows for the Project menu; `radio` renders a `radiogroup`
 * with arrow-key selection for the Settings sheet.
 */
export function AppearanceControl({
  value,
  onChange,
  variant,
}: AppearanceValue & { variant: "menu" | "radio" }) {
  const group = useRef<HTMLDivElement>(null);
  if (variant === "menu") {
    return (
      <SegmentedControl role="none">
        {THEME_OPTIONS.map((option) => (
          <ToggleButton
            key={option.id}
            quiet
            role="menuitemradio"
            tabIndex={-1}
            pressed={value === option.id}
            aria-checked={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </ToggleButton>
        ))}
      </SegmentedControl>
    );
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = THEME_OPTIONS.findIndex((option) => option.id === value);
    const next =
      THEME_OPTIONS[(at + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
    if (!next) return;
    onChange(next.id);
    group.current
      ?.querySelector<HTMLElement>(`[data-theme-option="${next.id}"]`)
      ?.focus();
  };
  return (
    <div ref={group} role="presentation" onKeyDown={onKeyDown}>
      <SegmentedControl role="radiogroup" label="Appearance">
        {THEME_OPTIONS.map((option) => (
          <ToggleButton
            key={option.id}
            quiet
            role="radio"
            data-theme-option={option.id}
            tabIndex={value === option.id ? 0 : -1}
            pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </ToggleButton>
        ))}
      </SegmentedControl>
    </div>
  );
}
