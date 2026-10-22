import { type JoinVisual, joinWaveSpans } from "../edit/joinRender";
import { useDevicePixelRatio } from "../hooks/useDevicePixelRatio";
import type { ClipRow } from "../types/project";
import type { MediaRef } from "../waveform/types";
import { WaveformLayer } from "./WaveformLayer";

export type JoinWaveSides = {
  leftRef: MediaRef;
  rightRef: MediaRef;
  role: string;
  gainDb: number;
};

/** Narrower than this, the crossfade X would be a smear: only the waves draw. */
export const NARROW_OVERLAP_PX = 8;

const LEFT_KEY = "join-blend-left";
const RIGHT_KEY = "join-blend-right";

function JoinWaves({
  visual,
  left,
  right,
  waves,
  zoomPxPerSec,
}: {
  zoomPxPerSec: number;
  visual: Extract<JoinVisual, { kind: "blend" }>;
  left: Pick<ClipRow, "source_end">;
  right: Pick<ClipRow, "source_start">;
  waves: JoinWaveSides;
}) {
  const dpr = useDevicePixelRatio();
  const spans = joinWaveSpans(left, right, visual);
  if (!spans) return null;
  if (!spans.raster) {
    const hair = 1 / dpr;
    return (
      <span
        className="join-blend-seam"
        aria-hidden="true"
        data-exact-px={visual.widthPx}
        style={{
          left: visual.leftPx + visual.widthPx / 2 - hair / 2,
          width: hair,
        }}
      >
        <span className="join-blend-seam-left" />
        <span className="join-blend-seam-right" />
      </span>
    );
  }
  const layer = (
    side: "left" | "right",
    mediaRef: MediaRef,
    mediaStartSec: number,
    colorVar: string,
  ) => (
    <span className={`join-blend-wave join-blend-wave-${side}`}>
      <WaveformLayer
        mediaRef={mediaRef}
        kind="raw"
        mediaStartSec={mediaStartSec}
        clipLeftCss={visual.leftPx}
        clipWidthCss={visual.widthPx}
        zoom={zoomPxPerSec}
        colorVar={colorVar}
        role={waves.role}
        gainDb={waves.gainDb}
        minWidthCss={1}
      />
    </span>
  );
  return (
    <span
      className="join-blend-waves"
      aria-hidden="true"
      style={{ left: visual.leftPx, width: visual.widthPx }}
    >
      {layer("left", waves.leftRef, spans.leftMediaStartSec, LEFT_KEY)}
      {layer("right", waves.rightRef, spans.rightMediaStartSec, RIGHT_KEY)}
    </span>
  );
}

export function JoinBlend({
  visual,
  left,
  right,
  waves,
  zoomPxPerSec,
}: {
  visual: JoinVisual;
  left?: Pick<ClipRow, "source_end">;
  right?: Pick<ClipRow, "source_start">;
  waves?: JoinWaveSides;
  zoomPxPerSec: number;
}) {
  if (visual.kind !== "blend") return null;
  return (
    <>
      {waves && left && right ? (
        <JoinWaves
          visual={visual}
          left={left}
          right={right}
          waves={waves}
          zoomPxPerSec={zoomPxPerSec}
        />
      ) : null}
      <svg
        className="join-blend"
        aria-hidden="true"
        focusable="false"
        style={{ left: visual.leftPx, width: visual.widthPx }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {visual.widthPx < NARROW_OVERLAP_PX ? null : (
          <path d="M0 0L100 100M100 0L0 100" />
        )}
      </svg>
    </>
  );
}
