import type { ReactNode, Ref } from "react";
import type { ShellBreakpoint } from "../../state/types";
import type { StageId } from "../../types/stage";

export const STAGE_BODY_ID = "stage-body";

export type StageFrameViewProps = {
  shell: ShellBreakpoint;
  stage: StageId;
  /** Accessible name of the stage body. */
  stageLabel: string;
  guest?: boolean;
  following?: boolean;
  header: ReactNode;
  banners?: ReactNode;
  /** Host-supplied alerts that must not scroll away. */
  alerts?: ReactNode;
  /** The stage host. */
  children: ReactNode;
  /** The Player bar; null on Record. */
  player?: ReactNode;
  /** The phone tab bar; null off phone and for a link with one stage. */
  tabs?: ReactNode;
  sheet?: ReactNode;
  live?: ReactNode;
  overlay?: ReactNode;
  bindings?: {
    root?: Ref<HTMLDivElement>;
    header?: Ref<HTMLDivElement>;
    body?: Ref<HTMLElement>;
    player?: Ref<HTMLDivElement>;
  };
};

/**
 * Lays the frame out top to bottom: header, banners, alerts, the stage body,
 * the Player, and on a phone the tab bar. Props only; the adapter owns the
 * store, the role and the focus regions.
 */
export function StageFrameView({
  shell,
  stage,
  stageLabel,
  guest = false,
  following = false,
  header,
  banners,
  alerts,
  children,
  player,
  tabs,
  sheet,
  live,
  overlay,
  bindings,
}: StageFrameViewProps) {
  return (
    <div
      ref={bindings?.root}
      className={[
        "stage-frame",
        `stage-frame--${shell}`,
        guest ? "stage-frame--guest" : "",
        following ? "stage-frame--following" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-stage={stage}
    >
      <div ref={bindings?.header} className="stage-frame-header">
        {header}
      </div>
      <div className="stage-frame-banners">{banners}</div>
      <div className="stage-frame-alerts">{alerts}</div>
      <main
        ref={bindings?.body}
        id={STAGE_BODY_ID}
        className="stage-frame-body"
        aria-label={stageLabel}
      >
        {children}
      </main>
      {player ? (
        <div ref={bindings?.player} className="stage-frame-player">
          {player}
        </div>
      ) : null}
      {tabs ? <div className="stage-frame-tabs">{tabs}</div> : null}
      {sheet}
      {live}
      {overlay}
    </div>
  );
}
