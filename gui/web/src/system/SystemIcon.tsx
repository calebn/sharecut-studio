import type { SVGProps } from "react";
import {
  type CustomIconName,
  isCustomIcon,
  LUCIDE_ICONS,
  type SystemIconName,
} from "./icons";

/**
 * Lucide draws on a 24 grid at stroke 2; the 20 grid in `ui/Icon` uses 1.75.
 * 1.75 * 24 / 20 gives the same on-screen weight beside the existing set.
 */
export const SYSTEM_ICON_STROKE = 2.1;

type Props = {
  name: SystemIconName;
  /** Accessible name. Without it the icon is decorative (`aria-hidden`). */
  title?: string;
  size?: number;
  /** 0 to 1, for `progress-ring` only. */
  progress?: number;
} & Omit<SVGProps<SVGSVGElement>, "children" | "ref" | "name">;

const RING_RADIUS = 9;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function customGlyph(name: CustomIconName, progress: number | undefined) {
  switch (name) {
    case "record":
      return <circle cx="12" cy="12" r="8" fill="currentColor" stroke="none" />;
    case "stage-edit":
      return (
        <>
          <path d="M3 10v4M6.5 7v10M10 4v16M13.5 8v8" />
          <path d="M17 5h3M18.5 5v14M17 19h3" />
        </>
      );
    case "progress-ring": {
      const value = clamp01(progress ?? 0.25);
      return (
        <>
          <circle cx="12" cy="12" r={RING_RADIUS} opacity="0.3" />
          <circle
            cx="12"
            cy="12"
            r={RING_RADIUS}
            strokeDasharray={`${value * RING_LENGTH} ${RING_LENGTH}`}
            transform="rotate(-90 12 12)"
          />
        </>
      );
    }
  }
}

/** A design-system icon by DS name, on Lucide's 24 grid, `currentColor`. */
export function SystemIcon({
  name,
  title,
  size = 16,
  progress,
  ...rest
}: Props) {
  const common = {
    ...rest,
    width: size,
    height: size,
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
  } as const;
  if (isCustomIcon(name)) {
    return (
      <svg
        {...common}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={SYSTEM_ICON_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {title ? <title>{title}</title> : null}
        {customGlyph(name, progress)}
      </svg>
    );
  }
  const Glyph = LUCIDE_ICONS[name];
  return (
    <Glyph {...common} strokeWidth={SYSTEM_ICON_STROKE}>
      {title ? <title>{title}</title> : null}
    </Glyph>
  );
}
