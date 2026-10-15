import { Icon } from "./Icon";

export function GapMark({ detail }: { detail?: string }) {
  return (
    <span className="gap-mark">
      <Icon name="flatline" className="gap-mark-icon" aria-hidden="true" />
      <span className="gap-mark-text">Gap</span>
      {detail ? <span className="gap-mark-detail">{detail}</span> : null}
    </span>
  );
}
