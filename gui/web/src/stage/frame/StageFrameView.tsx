import type { CSSProperties, ReactNode, Ref } from "react";
import { presenceColorVar } from "../../presence/colors";
import type { ShellBreakpoint } from "../../state/types";
import type { StageId } from "../../types/stage";

export const STAGE_BODY_ID = "stage-body";

export type StageFrameViewProps = {
  shell: ShellBreakpoint;
  stage: StageId;
  /** Accessible name of the stage body. */
  stageLabel: string;
  guest?: boolean;
  /** Presence color slot of the person being followed; outlines the stage body. */
  followColorIndex?: number | null;
  header: ReactNode;
  banners?: ReactNode;
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
 * Lays the frame out top to bottom: header, banners, the stage body,
 * the Player, and on a phone the tab bar. Props only; the adapter owns the
 * store, the role and the focus regions.
 */
export function StageFrameView({
  shell,
  stage,
  stageLabel,
  guest = false,
  followColorIndex = null,
  header,
  banners,
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
        followColorIndex !== null ? "stage-frame--following" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-stage={stage}
      style={
        followColorIndex !== null
          ? ({
              "--stage-follow": presenceColorVar(followColorIndex),
            } as CSSProperties)
          : undefined
      }
    >
      <div ref={bindings?.header} className="stage-frame-header">
        {header}
      </div>
      <div className="stage-frame-banners">{banners}</div>
      <main
        ref={bindings?.body}
        id={STAGE_BODY_ID}
        className="stage-frame-body"
        aria-label={stageLabel}
        tabIndex={-1}
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
