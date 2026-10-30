import type { CSSProperties, ReactNode, Ref } from "react";
import type { SideYield } from "./sideFit";

/**
 * Side by side from 1000 px, stacked on a narrower tablet, one surface at a
 * time on a phone (spec-edit, main surface).
 */
export type EditArrangement = "side" | "stacked" | "phone";

export type EditWorkspaceState = "loading" | "ingest" | "arrange";

export interface EditWorkspaceViewProps {
  arrangement: EditArrangement;
  state: EditWorkspaceState;
  guest?: boolean;
  /** T hides the Script pane. */
  scriptHidden: boolean;
  /** Shift+T gives the Script the whole stage. */
  scriptFocus: boolean;
  scriptWidthRem: number;
  /** The pane that gives way because the side layout cannot hold them all. */
  yields?: SideYield;
  /** In and Out, the occurrence choice and the word handles, when the selection sheet does not carry them. */
  rangeFields?: ReactNode;
  actionBar?: ReactNode;
  /** The headers and lanes, or the empty-session drop target. */
  timeline: ReactNode;
  /** Zoom, eye and Script toggle over the lanes. */
  corner: ReactNode;
  divider: ReactNode;
  script: ReactNode;
  /** The desktop Inspector column; null while nothing is selected. */
  inspector?: ReactNode;
  /** Replaces everything on a phone. */
  phone?: ReactNode;
  /** Sheets that hang off the workspace (the tablet and phone Inspector). */
  sheet?: ReactNode;
  bindings?: {
    root?: Ref<HTMLDivElement>;
    timeline?: Ref<HTMLDivElement>;
    divider?: Ref<HTMLDivElement>;
    script?: Ref<HTMLDivElement>;
    inspector?: Ref<HTMLDivElement>;
  };
}

/** Pure layout of the Edit stage's regions; the adapter owns the store and the focus regions. */
export function EditWorkspaceView({
  arrangement,
  state,
  guest = false,
  scriptHidden,
  scriptFocus,
  scriptWidthRem,
  yields = null,
  rangeFields,
  actionBar,
  timeline,
  corner,
  divider,
  script,
  inspector,
  phone,
  sheet,
  bindings,
}: EditWorkspaceViewProps) {
  if (arrangement === "phone") {
    return (
      <div
        className="edit-workspace edit-workspace--phone"
        data-arrangement="phone"
        data-state={state}
      >
        {phone}
        {rangeFields}
        <div className="edit-dock">{actionBar}</div>
        {sheet}
      </div>
    );
  }
  const scriptShown = !scriptHidden || scriptFocus;
  return (
    <div
      ref={bindings?.root}
      className={[
        "edit-workspace",
        `edit-workspace--${arrangement}`,
        guest ? "edit-workspace--guest" : "",
        scriptFocus ? "edit-workspace--script-focus" : "",
        scriptShown ? "" : "edit-workspace--script-hidden",
        inspector ? "edit-workspace--inspector" : "",
        yields ? `edit-workspace--yield-${yields}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-arrangement={arrangement}
      data-state={state}
      style={{ "--script-width": `${scriptWidthRem}rem` } as CSSProperties}
    >
      <div
        ref={bindings?.timeline}
        className="edit-timeline-col"
        hidden={scriptFocus}
      >
        {rangeFields}
        <div className="edit-timeline-main" data-state={state}>
          {timeline}
        </div>
        {corner}
      </div>
      {scriptShown && !scriptFocus && arrangement === "side" ? (
        <div ref={bindings?.divider} className="edit-divider-slot">
          {divider}
        </div>
      ) : null}
      {scriptShown ? (
        <div ref={bindings?.script} className="edit-script">
          {script}
        </div>
      ) : null}
      {inspector ? (
        <div ref={bindings?.inspector} className="edit-inspector">
          {inspector}
        </div>
      ) : null}
      {actionBar}
      {sheet}
    </div>
  );
}
