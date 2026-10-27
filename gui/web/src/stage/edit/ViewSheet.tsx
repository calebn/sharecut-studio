import type { ReactNode } from "react";
import { capabilityLabel } from "../../capabilities/copy";
import { runPointerCommand } from "../../commands/pointer";
import { useDaw } from "../../state/useDaw";
import { CommandButton, SegmentedControl, ToggleButton } from "../../ui";
import { formatWaveformAmp } from "../../utils/zoom";
import { OverlayLegend } from "./OverlayLegend";
import { LegendCheckbox } from "./OverlayLegendView";
import { WAVEFORM_SCALES } from "./waveformScales";

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="view-sheet-section" aria-label={label}>
      <h3 className="view-sheet-heading">{label}</h3>
      {children}
    </section>
  );
}

/**
 * The eye sheet: the view toggles and scales, wired to their commands and
 * state.
 */
export function ViewSheet() {
  const {
    scale,
    amp,
    postFader,
    fitTracks,
    setWaveformScale,
    setWaveformPostFader,
  } = useDaw((s) => ({
    scale: s.waveformScale,
    amp: s.waveformAmpZoom,
    postFader: s.waveformPostFader,
    fitTracks: s.laneHeightMode === "fit",
    setWaveformScale: s.setWaveformScale,
    setWaveformPostFader: s.setWaveformPostFader,
  }));
  const readout = `×${formatWaveformAmp(amp)}`;
  return (
    <div className="view-sheet">
      <Section label="Layers">
        <OverlayLegend />
      </Section>
      <Section label="Waveform scale">
        <SegmentedControl label="Waveform scale" className="waveform-scales">
          {WAVEFORM_SCALES.map((m) => (
            <ToggleButton
              key={m.id}
              quiet
              pressed={scale === m.id}
              title={m.title}
              onClick={() => setWaveformScale(m.id)}
            >
              {m.label}
            </ToggleButton>
          ))}
        </SegmentedControl>
      </Section>
      <Section label="Waveform amplitude">
        <div className="view-sheet-row">
          <CommandButton
            commandId="view.waveformZoomOut"
            short
            title={`Waveform amplitude ${readout}`}
          />
          <span className="waveform-amp-readout">{readout}</span>
          <CommandButton
            commandId="view.waveformZoomIn"
            short
            title={`Waveform amplitude ${readout}`}
          />
        </div>
        <LegendCheckbox checked={postFader} onChange={setWaveformPostFader}>
          Show waveforms post-fader
        </LegendCheckbox>
      </Section>
      <Section label="Track height">
        <div className="view-sheet-row">
          <CommandButton commandId="view.trackHeightDecrease" short />
          <CommandButton commandId="view.trackHeightIncrease" short />
        </div>
        <LegendCheckbox
          checked={fitTracks}
          onChange={() => runPointerCommand("view.fitTracksHeight")}
        >
          {capabilityLabel("daw.view.fitTracksHeight")}
        </LegendCheckbox>
      </Section>
      <Section label="Zoom">
        <div className="view-sheet-row">
          <CommandButton commandId="view.zoomOut" />
          <CommandButton commandId="view.zoomIn" />
          <CommandButton commandId="view.fit">
            {capabilityLabel("daw.view.fit")}
          </CommandButton>
        </div>
      </Section>
    </div>
  );
}
