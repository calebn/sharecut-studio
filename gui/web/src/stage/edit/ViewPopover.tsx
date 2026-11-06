import { announceWaveformAmp } from "../../commands/view";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { ViewPopoverSlotProps } from "./EditCornerView";
import { ViewPopoverView } from "./ViewPopoverView";

/** The eye popover wired to the layer, waveform scale and amplitude state. */
export function ViewPopover({ anchorRef, onClose }: ViewPopoverSlotProps) {
  const s = useDaw((st) => ({
    layers: st.layers,
    setLayerVisible: st.setLayerVisible,
    postFader: st.waveformPostFader,
    setWaveformPostFader: st.setWaveformPostFader,
    scale: st.waveformScale,
    setWaveformScale: st.setWaveformScale,
    amp: st.waveformAmpZoom,
    setWaveformAmpZoom: st.setWaveformAmpZoom,
    stopFollow: st.stopFollow,
    projectPath: st.projectPath,
  }));
  const onAmpChange = (amp: number) => {
    s.stopFollow("local");
    s.setWaveformAmpZoom(amp);
    announceWaveformAmp();
  };
  return (
    <ViewPopoverView
      anchorRef={anchorRef}
      onClose={onClose}
      layers={s.layers}
      onLayerChange={s.setLayerVisible}
      postFader={s.postFader}
      onPostFaderChange={s.setWaveformPostFader}
      scale={s.scale}
      onScaleChange={s.setWaveformScale}
      amp={s.amp}
      onAmpChange={onAmpChange}
      hostLayers={!isShareProjectKey(s.projectPath)}
    />
  );
}
