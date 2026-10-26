import type { WaveformScaleMode } from "../waveform/types";

export const WAVEFORM_SCALES: {
  id: WaveformScaleMode;
  label: string;
  title: string;
}[] = [
  {
    id: "auto",
    label: "Auto",
    title: "Decibel scale for dialogue tracks, linear for music and effects",
  },
  { id: "linear", label: "Linear", title: "Linear amplitude on every track" },
  { id: "log", label: "Log (dB)", title: "Decibel scale on every track" },
];
