import { useDaw } from "../state/useDaw";
import {
  CommandMenuItem,
  MenuSection,
  SegmentedControl,
  ToggleButton,
} from "../ui";
import { formatWaveformAmp } from "../utils/zoom";
import type { WaveformScaleMode } from "../waveform/types";
import { LegendCheckbox } from "./OverlayLegend";

const SCALES: { id: WaveformScaleMode; label: string; title: string }[] = [
  {
    id: "auto",
    label: "Auto",
    title: "Decibel scale for dialogue tracks, linear for music and effects",
  },
  { id: "linear", label: "Linear", title: "Linear amplitude on every track" },
  { id: "log", label: "Log (dB)", title: "Decibel scale on every track" },
];

/** View › Waveform scale radios, amplitude −/+ with its readout, and post-fader drawing (#530). */
export function WaveformViewSections() {
  const { scale, amp, postFader, setWaveformScale, setWaveformPostFader } =
    useDaw((s) => ({
      scale: s.waveformScale,
      amp: s.waveformAmpZoom,
      postFader: s.waveformPostFader,
      setWaveformScale: s.setWaveformScale,
      setWaveformPostFader: s.setWaveformPostFader,
    }));
  const readout = `×${formatWaveformAmp(amp)}`;
  return (
    <>
      <MenuSection label="Waveform scale">
        <SegmentedControl role="none" className="waveform-scales">
          {SCALES.map((m) => (
            <ToggleButton
              key={m.id}
              quiet
              role="menuitemradio"
              pressed={scale === m.id}
              aria-checked={scale === m.id}
              title={m.title}
              onClick={() => setWaveformScale(m.id)}
            >
              {m.label}
            </ToggleButton>
          ))}
        </SegmentedControl>
      </MenuSection>
      <MenuSection label="Waveform amplitude">
        <div className="transport-controls" role="none">
          <CommandMenuItem
            commandId="view.waveformZoomOut"
            showShortcut={false}
            title={`Waveform amplitude ${readout}`}
          >
            Amplitude −
          </CommandMenuItem>
          <span className="waveform-amp-readout" aria-hidden="true">
            {readout}
          </span>
          <CommandMenuItem
            commandId="view.waveformZoomIn"
            showShortcut={false}
            title={`Waveform amplitude ${readout}`}
          >
            Amplitude +
          </CommandMenuItem>
        </div>
        <div className="overlay-legend" role="none">
          <LegendCheckbox
            menu
            checked={postFader}
            onChange={setWaveformPostFader}
          >
            Show waveforms post-fader
          </LegendCheckbox>
        </div>
      </MenuSection>
    </>
  );
}
