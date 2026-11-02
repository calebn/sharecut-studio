import { useCallback } from "react";
import { useDawStore } from "../state/dawStore";
import type { VirtualPiece } from "../utils/clipTiming";
import type { MediaRef, WaveformKind } from "../waveform/types";
import { timelineTestIds } from "./selectors";
import { PIECE_CULL_MIN, visiblePieceRange } from "./visiblePieces";
import { WaveformLayer } from "./WaveformLayer";

type Props = {
  pieces: readonly VirtualPiece[];
  leftCss: number;
  zoom: number;
  mediaRef: MediaRef;
  kind: WaveformKind;
  colorVar: string;
  role: string;
  gainDb: number;
};

export function PieceWaveforms({
  pieces,
  leftCss,
  zoom,
  mediaRef,
  kind,
  colorVar,
  role,
  gainDb,
}: Props) {
  const culled = pieces.length > PIECE_CULL_MIN;
  const window = useDawStore(
    useCallback(
      (s: { scrollLeft: number; timelineViewportWidth: number }) =>
        culled
          ? visiblePieceRange({
              pieces,
              leftCss,
              zoom,
              scrollLeft: s.scrollLeft,
              viewportWidth: s.timelineViewportWidth,
            }).join(":")
          : "",
      [culled, pieces, leftCss, zoom],
    ),
  );
  const [lo, hi] = culled
    ? window.split(":").map(Number)
    : [0, pieces.length - 1];
  return (
    <>
      {pieces.map((piece, i) =>
        i < lo! || i > hi! ? null : (
          <span
            key={`${piece.srcA}-${piece.tlA}`}
            data-testid={timelineTestIds.waveformPiece}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: piece.tlA * zoom,
              width: (piece.srcB - piece.srcA) * zoom,
              pointerEvents: "none",
            }}
          >
            <WaveformLayer
              mediaRef={mediaRef}
              kind={kind}
              mediaStartSec={piece.srcA}
              clipLeftCss={leftCss + piece.tlA * zoom}
              clipWidthCss={(piece.srcB - piece.srcA) * zoom}
              zoom={zoom}
              colorVar={colorVar}
              role={role}
              gainDb={gainDb}
            />
          </span>
        ),
      )}
    </>
  );
}
