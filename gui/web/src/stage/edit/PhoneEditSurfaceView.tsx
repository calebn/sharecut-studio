import type { ReactNode, Ref } from "react";
import { SystemIcon } from "../../system/SystemIcon";
import type { EditSurface } from "../../types/stage";
import { Button, Icon, SegmentedControl, ToggleButton } from "../../ui";

export interface PhoneEditSurfaceViewProps {
  surface: EditSurface;
  onSurfaceChange: (surface: EditSurface) => void;
  /** The zoom, eye and (touch) range cluster over the lanes. */
  corner: ReactNode;
  lanes: ReactNode;
  script: ReactNode;
  /** Opens the Mix sheet; absent for a link that cannot change the mix. */
  onOpenMix?: () => void;
  /** Focus regions: the timeline side keeps timeline keys, the Script does not. */
  bindings?: { lanes?: Ref<HTMLDivElement>; script?: Ref<HTMLElement> };
}

/** The Timeline and Script toggle; the bar and the Tools sheet both show it. */
export function EditSurfaceSwitch({
  surface,
  onSurfaceChange,
}: {
  surface: EditSurface;
  onSurfaceChange: (surface: EditSurface) => void;
}) {
  return (
    <SegmentedControl label="Edit surface" className="phone-edit-switch">
      <ToggleButton
        quiet
        pressed={surface === "lanes"}
        title="Timeline"
        aria-label="Timeline"
        onClick={() => onSurfaceChange("lanes")}
      >
        <Icon name="timeline" />
      </ToggleButton>
      <ToggleButton
        quiet
        pressed={surface === "text"}
        title="Script"
        aria-label="Script"
        onClick={() => onSurfaceChange("text")}
      >
        <Icon name="text" />
      </ToggleButton>
    </SegmentedControl>
  );
}

/**
 * The phone's Edit: the lanes or the Script, never both, switched at the top
 * of the stage. Selection and playhead live in the store, so they carry across.
 */
export function PhoneEditSurfaceView({
  surface,
  onSurfaceChange,
  corner,
  lanes,
  script,
  onOpenMix,
  bindings,
}: PhoneEditSurfaceViewProps) {
  return (
    <div className="phone-edit" data-surface={surface}>
      <div className="phone-edit-bar">
        <EditSurfaceSwitch
          surface={surface}
          onSurfaceChange={onSurfaceChange}
        />
        {onOpenMix ? (
          <Button
            className="phone-edit-mix"
            title="Mix"
            aria-label="Mix"
            onClick={onOpenMix}
          >
            <SystemIcon name="sliders-horizontal" size={20} />
          </Button>
        ) : null}
      </div>
      {surface === "lanes" ? (
        <div ref={bindings?.lanes} className="phone-edit-timeline">
          <div className="phone-edit-lanes">
            {lanes}
            {corner}
          </div>
        </div>
      ) : (
        <section
          ref={bindings?.script}
          className="phone-edit-script"
          aria-label="Script"
        >
          {script}
        </section>
      )}
    </div>
  );
}
