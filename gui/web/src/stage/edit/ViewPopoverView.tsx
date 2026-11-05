import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import type { SystemIconName } from "../../system/icons";
import { ScrubField } from "../../system/ScrubField";
import { SystemIcon } from "../../system/SystemIcon";
import { SegmentedControl, ToggleButton } from "../../ui";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { useAnchoredPanel } from "../../ui/useAnchoredPanel";
import { usePopoverKeyboard } from "../../ui/useMenuKeyboard";
import { useOutsidePointerDown } from "../../ui/useOutsidePointerDown";
import { useTopLayerPanel } from "../../ui/useTopLayerPanel";
import {
  MAX_WAVEFORM_AMP,
  MIN_WAVEFORM_AMP,
  WAVEFORM_AMP_DECIMALS,
  ZOOM_STEP,
} from "../../utils/zoom";
import type { WaveformScaleMode } from "../../waveform/types";
import { WAVEFORM_SCALES } from "./waveformScales";

export type ViewLayerKey = "showProsody" | "showSilence" | "showLevels";

const LAYER_CHIPS: {
  key: ViewLayerKey;
  label: string;
  icon: SystemIconName;
  hostOnly?: boolean;
}[] = [
  {
    key: "showProsody",
    label: "Prosody",
    icon: "audio-waveform",
    hostOnly: true,
  },
  { key: "showSilence", label: "Silence shading", icon: "volume-x" },
  { key: "showLevels", label: "Volume envelope", icon: "spline" },
];

export interface ViewPopoverViewProps {
  /** The eye: the popover hangs off it and focus returns to it. */
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  layers: Record<ViewLayerKey, boolean>;
  onLayerChange: (key: ViewLayerKey, visible: boolean) => void;
  postFader: boolean;
  onPostFaderChange: (postFader: boolean) => void;
  scale: WaveformScaleMode;
  onScaleChange: (scale: WaveformScaleMode) => void;
  amp: number;
  onAmpChange: (amp: number) => void;
  /** false for share viewers: no Prosody chip. */
  hostLayers?: boolean;
}

/** The linear ramp, the log curve and the auto "A" (spec-edit MENU-VIEW). */
function ScaleGlyph({ mode }: { mode: WaveformScaleMode }): ReactNode {
  if (mode === "auto") {
    return (
      <span className="view-popover-auto" aria-hidden="true">
        A
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={mode === "linear" ? "M4 16 L16 4" : "M4 16 C5 6 9 4 16 4"} />
    </svg>
  );
}

/**
 * The eye popover (spec-edit MENU-VIEW): 240 px, non-modal, in the top layer
 * beside the eye, flipped above or below by room, on every shell (no Sheet).
 * Escape and a press outside close it, as does another dialog taking focus;
 * focus returns to the eye on Escape and when Tab leaves either end. A typed
 * amplitude is committed when the popover closes.
 */
export function ViewPopoverView({
  anchorRef,
  panelRef: ownerPanelRef,
  onClose,
  layers,
  onLayerChange,
  postFader,
  onPostFaderChange,
  scale,
  onScaleChange,
  amp,
  onAmpChange,
  hostLayers = true,
}: ViewPopoverViewProps) {
  const localPanelRef = useRef<HTMLDivElement | null>(null);
  const panelRef = ownerPanelRef ?? localPanelRef;
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const { ref: topLayerRef, popover } = useTopLayerPanel();
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      const detach = topLayerRef(el);
      return () => {
        panelRef.current = null;
        detach?.();
      };
    },
    [topLayerRef, panelRef],
  );
  useEffect(() => {
    if (isValidFocusTarget(anchorRef.current)) firstRef.current?.focus();
  }, [anchorRef]);
  // Escape and Tab out of an end hand focus back to the eye. Every other close
  // (a press outside, another dialog taking focus) leaves focus where the
  // press or the dialog put it.
  const closeToEye = useCallback(() => {
    if (isValidFocusTarget(anchorRef.current)) anchorRef.current.focus();
    onClose();
  }, [anchorRef, onClose]);
  useAnchoredPanel(
    panelRef,
    {
      reason:
        "The eye popover stays beside the corner on every shell: the lanes it changes must stay visible.",
      ref: anchorRef,
      prefer: "above",
    },
    true,
  );
  useOutsidePointerDown({
    liveRefs: [panelRef, anchorRef],
    onOutside: onClose,
  });

  usePopoverKeyboard({
    panelRef,
    anchorRef,
    close: closeToEye,
    closeAway: onClose,
  });

  const chips = LAYER_CHIPS.filter((c) => hostLayers || !c.hostOnly);
  return createPortal(
    <div
      ref={attach}
      popover={popover}
      className="view-popover"
      role="dialog"
      aria-modal="false"
      aria-label="View options"
      tabIndex={-1}
    >
      <div
        className="view-popover-chips"
        role="group"
        aria-label="Display options"
      >
        {chips.map(({ key, label, icon }, i) => (
          <ToggleButton
            key={key}
            ref={i === 0 ? firstRef : undefined}
            quiet
            className="view-popover-chip"
            pressed={layers[key]}
            title={label}
            aria-label={label}
            onClick={() => onLayerChange(key, !layers[key])}
          >
            <SystemIcon name={icon} size={20} />
          </ToggleButton>
        ))}
        <ToggleButton
          quiet
          className="view-popover-chip"
          pressed={postFader}
          title="Waveforms post-fader"
          aria-label="Waveforms post-fader"
          onClick={() => onPostFaderChange(!postFader)}
        >
          <SystemIcon name="sliders-horizontal" size={20} />
        </ToggleButton>
      </div>
      <SegmentedControl label="Waveform scale" className="view-popover-scales">
        {WAVEFORM_SCALES.map((m) => (
          <ToggleButton
            key={m.id}
            quiet
            pressed={scale === m.id}
            title={m.title}
            aria-label={m.label}
            onClick={() => onScaleChange(m.id)}
          >
            <ScaleGlyph mode={m.id} />
          </ToggleButton>
        ))}
      </SegmentedControl>
      <div className="view-popover-amp">
        <span className="view-popover-caption" aria-hidden="true">
          Amplitude
        </span>
        <ScrubField
          label="Waveform amplitude"
          variant="plain"
          unit="×"
          multiplicative
          step={ZOOM_STEP}
          decimals={WAVEFORM_AMP_DECIMALS}
          commitOnUnmount
          min={MIN_WAVEFORM_AMP}
          max={MAX_WAVEFORM_AMP}
          defaultValue={1}
          value={amp}
          onCommit={onAmpChange}
        />
      </div>
    </div>,
    document.body,
  );
}
