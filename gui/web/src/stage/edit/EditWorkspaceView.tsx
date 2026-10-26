import type { CSSProperties, ReactNode, Ref } from "react";

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
  /** Range actions above the lanes, when the selection sheet does not carry them. */
  rangeActions?: ReactNode;
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
    timeline?: Ref<HTMLDivElement>;
    divider?: Ref<HTMLDivElement>;
    script?: Ref<HTMLElement>;
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
  rangeActions,
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
        {sheet}
      </div>
    );
  }
  const scriptShown = !scriptHidden || scriptFocus;
  return (
    <div
      className={[
        "edit-workspace",
        `edit-workspace--${arrangement}`,
        guest ? "edit-workspace--guest" : "",
        scriptFocus ? "edit-workspace--script-focus" : "",
        scriptShown ? "" : "edit-workspace--script-hidden",
        inspector ? "edit-workspace--inspector" : "",
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
        {rangeActions}
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
        <section
          ref={bindings?.script}
          className="edit-script"
          aria-label="Script"
        >
          {script}
        </section>
      ) : null}
      {inspector ? (
        <div ref={bindings?.inspector} className="edit-inspector">
          {inspector}
        </div>
      ) : null}
      {sheet}
    </div>
  );
}
