import type { ReactNode } from "react";
import type { SystemIconName } from "../../system/icons";
import { SystemIcon } from "../../system/SystemIcon";

type Props = {
  icon: SystemIconName;
  label: string;
  /** Plain words under the label, such as where the row leads. */
  detail?: string;
} & (
  | { onSelect: () => void; href?: undefined }
  | { href: string; onSelect?: undefined }
);

export function MenuRow({ icon, label, detail, onSelect, href }: Props) {
  const body: ReactNode = (
    <>
      <SystemIcon name={icon} size={16} />
      <span className="set-row-text">
        <span className="set-row-label">{label}</span>
        {detail ? <span className="set-row-detail">{detail}</span> : null}
      </span>
      <SystemIcon name="chevron-right" size={16} />
    </>
  );
  if (href) {
    return (
      <a className="set-row" href={href} target="_blank" rel="noreferrer">
        {body}
      </a>
    );
  }
  return (
    <button type="button" className="set-row" onClick={onSelect}>
      {body}
    </button>
  );
}
