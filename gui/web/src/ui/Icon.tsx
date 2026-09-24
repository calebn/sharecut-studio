import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "play"
  | "pause"
  | "stop"
  | "select"
  | "blade"
  | "comment"
  | "fit"
  | "menu"
  | "cutAtPlayhead"
  | "agent"
  | "layers"
  | "close"
  | "listen"
  | "timeline"
  | "text"
  | "more";

type Props = {
  name: IconName;
  title?: string;
  className?: string;
  size?: number;
} & Omit<SVGProps<SVGSVGElement>, "children" | "ref">;

/** Transport glyphs are filled by convention; the rest of the set is stroked. */
const FILLED = { fill: "currentColor" } as const;

const PATHS: Record<IconName, ReactElement> = {
  play: <path {...FILLED} d="m6.5 4.5 9 5.5-9 5.5Z" />,
  pause: (
    <>
      <rect {...FILLED} x="5.5" y="4.5" width="3" height="11" rx="0.75" />
      <rect {...FILLED} x="11.5" y="4.5" width="3" height="11" rx="0.75" />
    </>
  ),
  stop: <rect {...FILLED} x="5.5" y="5.5" width="9" height="9" rx="1" />,
  select: (
    <>
      <path d="M5 3.5 5 16.5 8.2 13.2 10.5 18.5 12.6 17.6 10.3 12.3 14.5 12.3Z" />
    </>
  ),
  blade: (
    <>
      <circle cx="5.5" cy="5" r="2.25" />
      <circle cx="5.5" cy="15" r="2.25" />
      <path d="M7.3 6.3 15.5 14.2" />
      <path d="M7.3 13.7 15.5 5.8" />
    </>
  ),
  comment: (
    <>
      <path d="M4.5 5.5h11a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H9.5L6 16.5v-3H4.5A1.5 1.5 0 0 1 3 12V7a1.5 1.5 0 0 1 1.5-1.5Z" />
    </>
  ),
  fit: (
    <>
      <path d="M4 8V4.5h3.5" />
      <path d="M16 8V4.5h-3.5" />
      <path d="M4 12v3.5h3.5" />
      <path d="M16 12v3.5h-3.5" />
      <rect x="7" y="7" width="6" height="6" rx="0.5" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6.5h12" />
      <path d="M4 10h12" />
      <path d="M4 13.5h12" />
    </>
  ),
  cutAtPlayhead: (
    <>
      <path d="M10 3.5v13" />
      <path d="M4 14.5 8 10.5 4 6.5" />
      <path d="M16 6.5 12 10.5 16 14.5" />
    </>
  ),
  agent: (
    <>
      <rect x="4.5" y="6.5" width="11" height="9" rx="2" />
      <circle cx="8" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <path d="M7.5 14h5" />
      <path d="M10 3.5v3" />
      <path d="M7 5.5h6" />
    </>
  ),
  layers: (
    <>
      <path d="m10 3.5 6.5 3.25L10 10 3.5 6.75Z" />
      <path d="m3.5 10.25 6.5 3.25 6.5-3.25" />
      <path d="m3.5 13.75 6.5 3.25 6.5-3.25" />
    </>
  ),
  close: (
    <>
      <path d="m5.5 5.5 9 9" />
      <path d="m14.5 5.5-9 9" />
    </>
  ),
  listen: (
    <>
      <path d="M4 12.5V10a6 6 0 0 1 12 0v2.5" />
      <rect x="3.5" y="11.5" width="3.5" height="5" rx="1.25" />
      <rect x="13" y="11.5" width="3.5" height="5" rx="1.25" />
    </>
  ),
  timeline: (
    <>
      <path d="M3.5 6.5h8" />
      <path d="M6.5 10h10" />
      <path d="M3.5 13.5h6" />
      <path d="M13 3.5v13" />
    </>
  ),
  text: (
    <>
      <path d="M4 5.5h12" />
      <path d="M4 9h12" />
      <path d="M4 12.5h12" />
      <path d="M4 16h7" />
    </>
  ),
  more: (
    <>
      <circle {...FILLED} cx="5" cy="10" r="1.25" stroke="none" />
      <circle {...FILLED} cx="10" cy="10" r="1.25" stroke="none" />
      <circle {...FILLED} cx="15" cy="10" r="1.25" stroke="none" />
    </>
  ),
};

/** Compact 16px stroke icons for transport / tool chrome (`currentColor`). */
export function Icon({ name, title, className, size = 16, ...rest }: Props) {
  return (
    <svg
      {...rest}
      className={className ? `ui-icon ${className}` : "ui-icon"}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
