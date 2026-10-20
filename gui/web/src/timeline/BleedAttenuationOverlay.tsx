import {
  BLEED_ATTENUATION_LABELS,
  type BleedAttenuationRegion,
  bleedAttenuationRegionKey,
  bleedAttenuationRegionLabel,
} from "../edit/bleedAttenuation";
import { Button } from "../ui/Button";
import { hitTargetProps } from "./hitTargets";
import "./BleedAttenuationOverlay.css";

export type BleedAttenuationOverlayProps<TTarget> = {
  regions: readonly {
    region: BleedAttenuationRegion<TTarget>;
    leftPx: number;
    widthPx: number;
  }[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
};

export function BleedAttenuationOverlay<TTarget>({
  regions,
  selectedKey,
  onSelect,
}: BleedAttenuationOverlayProps<TTarget>) {
  if (!regions.length) return null;
  return (
    <div
      className="bleed-attenuation-layer"
      role="group"
      aria-label="Automatic audio reduction"
    >
      {regions.map(({ region, leftPx, widthPx }) => {
        const key = bleedAttenuationRegionKey(region);
        return (
          <div
            key={key}
            className="bleed-attenuation-band"
            data-selected={selectedKey === key ? "true" : undefined}
            style={{ left: leftPx, width: widthPx }}
          >
            <Button
              {...hitTargetProps(
                "bleed-attenuation",
                key,
                region.timelineSpan.start,
                {
                  selected: selectedKey === key,
                  detail: BLEED_ATTENUATION_LABELS[region.kind],
                },
              )}
              className="bleed-attenuation-pick"
              aria-label={bleedAttenuationRegionLabel(region)}
              aria-pressed={selectedKey === key}
              title={bleedAttenuationRegionLabel(region)}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(key);
              }}
            >
              {BLEED_ATTENUATION_LABELS[region.kind]}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
