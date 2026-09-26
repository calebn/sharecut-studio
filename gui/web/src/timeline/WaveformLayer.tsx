import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useDevicePixelRatio } from "../hooks/useDevicePixelRatio";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  MIN_CLIP_CSS_PX,
  QUIET_WASH_MIN_ZOOM_PX_PER_SEC,
  RENDER_TILE_CSS_PX,
} from "../utils/timelineZoom.generated";
import { bitmapCache } from "../waveform/bitmapCache";
import { getPcm, requestPcm, subscribePcm } from "../waveform/pcmStore";
import { binRangeForFrames } from "../waveform/pyramidMath";
import {
  getBins,
  hasBins,
  PRIORITY_OVERSCAN,
  PRIORITY_VISIBLE,
  requestTiles,
  subscribePyramid,
} from "../waveform/pyramidStore";
import {
  hasRaster,
  requestRaster,
  subscribeRasterDone,
  subscribeRasterDropped,
  subscribeRasterFailed,
} from "../waveform/rasterClient";
import {
  drawLevel,
  heightDevice,
  pcmBlocksFor,
  placeholderMapping,
  rasterMode,
  renderScale,
  styleKey,
  type TileIdentity,
  type TileRect,
  tileFrames,
  tileGroup,
  tileKey,
  tileOrigin,
  tileRect,
  visibleTileRange,
} from "../waveform/renderTiles";
import { useWaveformStatus } from "../waveform/statusStore";
import {
  isReady,
  type MediaRef,
  type RasterJob,
  type ReadyEntry,
  type WaveformKind,
  type WaveformStyle,
} from "../waveform/types";
import { quietBandsInView } from "./quietWash";
import { useTimelineMetrics } from "./timelineMetrics";
import { useResolvedTheme, waveformStyle } from "./waveformTheme";

type Props = {
  mediaRef: MediaRef;
  kind: WaveformKind;
  /** Media time (s) at the clip's left edge (preview-aware). */
  mediaStartSec: number;
  /** Timeline x (css px) and width of the clip's border box. */
  clipLeftCss: number;
  clipWidthCss: number;
  zoom: number;
  /** Lane colour (e.g. `var(--clip-dialogue-0)`): keys the cached tints. */
  colorVar: string;
};

type Tile = { k: number; rect: TileRect };

function parseRange(range: string): [number, number] | null {
  if (!range) {
    return null;
  }
  const [a, b] = range.split(":").map(Number);
  return [a!, b!];
}

/** A ready entry with the project and ref it describes. */
type HeldReady = { projectPath: string; ref: MediaRef; entry: ReadyEntry };

/**
 * The newest ready entry for this layer, with its ref: a new ref's pyramid
 * replaces the old one only once it is ready (a cross-lane `source_id` flip
 * keeps drawing), and data requests use the held ref, so a key is never
 * sent under another ref. `unavailable` or a project change drops it.
 */
function useHeldReady(
  projectPath: string,
  ref: MediaRef,
  entry: ReturnType<typeof useWaveformStatus>,
): HeldReady | null {
  const [held, setHeld] = useState<HeldReady | null>(null);
  let next: HeldReady | null;
  if (isReady(entry)) {
    next =
      held?.entry === entry &&
      held.ref === ref &&
      held.projectPath === projectPath
        ? held
        : { projectPath, ref, entry };
  } else if (
    entry?.status === "unavailable" ||
    held?.projectPath !== projectPath
  ) {
    next = null;
  } else {
    next = held;
  }
  if (next !== held) {
    setHeld(next);
  }
  return next;
}

/** Height of the layer (css px), from a ResizeObserver: no layout reads in render. */
function useLayerHeight(el: HTMLElement | null, laneHeight: number): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, laneHeight]);
  return height;
}

function drawBitmap(
  canvas: HTMLCanvasElement,
  draw: (ctx: CanvasRenderingContext2D) => void,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  draw(ctx);
}

/** Quiet wash bands over the mounted tile range. */
function quietBands(
  meta: ReadyEntry | null,
  range: string,
  origin: number,
  zoom: number,
  clipWidthCss: number,
) {
  const r = parseRange(range);
  if (!meta || !r || zoom < QUIET_WASH_MIN_ZOOM_PX_PER_SEC) {
    return [];
  }
  const x0 = Math.max(0, r[0] * RENDER_TILE_CSS_PX + origin);
  const x1 = Math.min(clipWidthCss, (r[1] + 1) * RENDER_TILE_CSS_PX + origin);
  // Clip-relative CSS px to media seconds.
  const sec = (x: number) => (x - origin) / zoom;
  return quietBandsInView(
    meta,
    zoom,
    [sec(x0), sec(x1)],
    [sec(0), sec(clipWidthCss)],
  );
}

/**
 * One clip's waveform: source-anchored render tiles drawn from cached
 * bitmaps, rasterized off the main thread. Moving, trimming or splitting a
 * clip changes only where tiles sit; zoom, DPR, height, amp zoom or theme
 * pick new tiles, and a nearby cached tile stands in until they arrive.
 */
function WaveformLayerView({
  mediaRef,
  kind,
  mediaStartSec,
  clipLeftCss,
  clipWidthCss,
  zoom,
  colorVar,
}: Props) {
  const projectPath = useDawStore((s) => s.projectPath);
  const ampZoom = useDawStore((s) => s.waveformAmpZoom);
  const theme = useResolvedTheme();
  const dprReal = useDevicePixelRatio();
  const { laneHeight } = useTimelineMetrics();
  const held = useHeldReady(
    projectPath,
    mediaRef,
    useWaveformStatus(projectPath, kind, mediaRef),
  );
  const meta = held?.entry ?? null;
  // Data requests go out under the ref the held pyramid belongs to.
  const dataRef = held?.ref ?? mediaRef;
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const heightCss = useLayerHeight(el, laneHeight);
  // Resolved once per (theme, lane colour) and cached; reads no layout.
  const style = useMemo<WaveformStyle | null>(
    () => (el ? waveformStyle(el, colorVar, theme) : null),
    [el, colorVar, theme],
  );

  const { d } = renderScale(dprReal);
  const heightDev = heightDevice(heightCss, d);
  const origin = tileOrigin({ clipLeftCss, mediaStartSec, zoom, dprReal });
  // A primitive, so scrolling re-renders the layer only when tiles change.
  const range = useDawStore(
    useCallback(
      (s: { scrollLeft: number; timelineViewportWidth: number }) => {
        const r = visibleTileRange({
          origin,
          clipLeftCss,
          clipWidthCss,
          scrollLeft: s.scrollLeft,
          viewportWidth: s.timelineViewportWidth,
        });
        return r ? `${r[0]}:${r[1]}` : "";
      },
      [origin, clipLeftCss, clipWidthCss],
    ),
  );
  const wanted = useRef(new Set<string>());
  const [, bumpData] = useReducer((n: number) => n + 1, 0);
  // Bumps when this media's pyramid tiles land: the only data the quiet wash
  // reads (PCM and raster-done events re-render the layer but reuse it).
  const [pyramidRev, bumpPyramid] = useReducer((n: number) => n + 1, 0);
  const mediaKey = meta?.key ?? "";
  useEffect(() => {
    if (!mediaKey) {
      return;
    }
    const prefix = `${mediaKey}|`;
    const askAgain = (key: string) => {
      if (wanted.current.has(key)) {
        bumpData();
      }
    };
    const offs = [
      subscribePyramid(mediaKey, bumpPyramid),
      subscribePcm(mediaKey, bumpData),
      subscribeRasterDone((key) => {
        if (key.startsWith(prefix)) {
          bumpData();
        }
      }),
      // A queued job this layer skipped (another layer's) was dropped: ask again.
      subscribeRasterDropped(askAgain),
      // A job died with a crashed worker: ask again (a restarted one takes it).
      subscribeRasterFailed(askAgain),
    ];
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }, [mediaKey]);

  const identity: TileIdentity | null =
    meta && style && heightDev > 0
      ? {
          mediaKey: meta.key,
          zoom,
          d,
          heightDev,
          styleKey: styleKey(style),
          ampZoom,
        }
      : null;
  const ready = identity != null;
  const tiles = useMemo<Tile[]>(() => {
    const r = parseRange(range);
    if (!r || !ready) {
      return [];
    }
    const out: Tile[] = [];
    for (let k = r[0]; k <= r[1]; k++) {
      const rect = tileRect(k, origin, clipWidthCss, d);
      if (rect) {
        out.push({ k, rect });
      }
    }
    return out;
  }, [range, ready, origin, clipWidthCss, d]);

  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const drawn = useRef(new WeakMap<HTMLCanvasElement, string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Draw what is cached, stand in for the rest, and ask for data and rasters.
  useLayoutEffect(() => {
    if (!meta || !style || !identity) {
      wanted.current = new Set();
      return;
    }
    const keys = new Set(tiles.map((t) => tileKey(identity, t.k)));
    wanted.current = keys;
    const hasPcm = !isShareProjectKey(projectPath);
    const source = { projectPath, ref: dataRef, meta };
    const group = tileGroup(identity);
    const { scrollLeft, timelineViewportWidth } = useDawStore.getState();
    const viewL = scrollLeft - clipLeftCss;
    const viewR = viewL + timelineViewportWidth;
    for (const { k, rect } of tiles) {
      const canvas = canvases.current.get(k);
      const key = tileKey(identity, k);
      // A resized canvas is blank, so the drawn tag includes its geometry.
      const tag = `${key}|${rect.sx}|${rect.sw}`;
      if (!canvas || drawn.current.get(canvas) === tag) {
        continue;
      }
      const exact = bitmapCache.get(key);
      if (exact) {
        drawBitmap(canvas, (ctx) =>
          ctx.drawImage(
            exact.bitmap,
            rect.sx,
            0,
            rect.sw,
            heightDev,
            0,
            0,
            rect.sw,
            heightDev,
          ),
        );
        drawn.current.set(canvas, tag);
        continue;
      }
      const stand = bitmapCache.placeholder(group, zoom, k);
      const map =
        stand &&
        placeholderMapping(
          {
            zoom: stand.entry.zoom,
            tile: stand.entry.tile,
            width: stand.entry.width,
          },
          { zoom, tile: k },
        );
      if (stand && map) {
        drawBitmap(canvas, (ctx) =>
          ctx.drawImage(
            stand.entry.bitmap,
            map.sx,
            0,
            map.sw,
            stand.entry.height,
            map.dx * d - rect.sx,
            0,
            map.dw * d,
            heightDev,
          ),
        );
        drawn.current.set(canvas, `~${tag}`);
      }
      const L = k * RENDER_TILE_CSS_PX + origin;
      const priority =
        L < viewR && L + RENDER_TILE_CSS_PX > viewL
          ? PRIORITY_VISIBLE
          : PRIORITY_OVERSCAN;
      // Its exact render is already queued or in flight: don't rebuild (and
      // copy) the job on every data event. This is safe because the tile key
      // fixes the job's data. It holds the media key (bins and PCM are
      // content-addressed by it), zoom, d, height, style and amp zoom, and an
      // exact job is built only from complete bins or PCM. Keep any new job
      // input in `tileKey`.
      if (hasRaster(key, false, priority)) {
        continue;
      }
      const frames = tileFrames(k, meta.sample_rate, zoom, d);
      const mode = rasterMode(frames.sppDev, meta.base_spp, hasPcm);
      const base = {
        cols: frames.cols,
        rows: heightDev,
        frameStart: frames.frameStart,
        sppDev: frames.sppDev,
        ampZoom,
        core: style.core,
        edge: style.edge,
      };
      const isWanted = () => mounted.current && wanted.current.has(key);
      const submit = (job: RasterJob, provisional: boolean) =>
        requestRaster({
          key,
          job,
          group,
          zoom,
          tile: k,
          provisional,
          priority,
          wanted: isWanted,
        });
      /** Bins of `level` for this tile, requesting missing data tiles. */
      const pyramidJob = (level: number, fetch: boolean): RasterJob | null => {
        const lvl = meta.levels[level];
        const [b0, b1] = binRangeForFrames(
          meta,
          level,
          frames.frameStart,
          frames.frameStart + frames.frames,
        );
        if (!lvl || b1 <= b0) {
          return null;
        }
        if (fetch) {
          const t0 = Math.floor(b0 / meta.bins_per_tile);
          const t1 = Math.floor((b1 - 1) / meta.bins_per_tile);
          requestTiles(
            source,
            level,
            Array.from({ length: t1 - t0 + 1 }, (_, i) => t0 + i),
            priority,
          );
        }
        if (!hasBins(meta, level, b0, b1 - b0)) {
          return null;
        }
        return {
          ...base,
          mode: "pyramid",
          source: {
            kind: "pyramid",
            bins: getBins(meta, level, b0, b1 - b0),
            binStart: b0,
            spp: lvl.spp,
          },
        };
      };
      let exactJob: RasterJob | null = null;
      let firstProvisional = 0;
      if (mode === "pyramid") {
        const level = drawLevel(meta, frames.sppDev);
        const [b0, b1] = binRangeForFrames(
          meta,
          level,
          frames.frameStart,
          frames.frameStart + frames.frames,
        );
        if (b1 <= b0) {
          // Past the end of the media: nothing to draw.
          drawn.current.set(canvas, tag);
          continue;
        }
        exactJob = pyramidJob(level, true);
        firstProvisional = level + 1;
      } else {
        const blocks = pcmBlocksFor(
          frames.frameStart,
          frames.frames,
          meta.total_frames,
        );
        if (!blocks) {
          drawn.current.set(canvas, tag);
          continue;
        }
        requestPcm({ projectPath, ref: dataRef, key: meta.key }, ...blocks);
        const pcm = getPcm(
          meta.key,
          frames.frameStart,
          frames.frames,
          meta.total_frames,
        );
        exactJob = pcm
          ? { ...base, mode, source: { kind: "pcm", ...pcm } }
          : null;
      }
      if (exactJob) {
        submit(exactJob, false);
        continue;
      }
      if (bitmapCache.hasProvisional(key) || hasRaster(key, true, priority)) {
        continue;
      }
      // Coarser data already loaded draws now; the exact tile follows.
      for (let level = firstProvisional; level < meta.levels.length; level++) {
        const job = pyramidJob(level, false);
        if (job) {
          submit(job, true);
          break;
        }
      }
    }
  });

  // Only the tile range, geometry or loaded pyramid tiles change the bands.
  const quiet = useMemo(() => {
    void pyramidRev; // new bins can fill columns that had no data
    return quietBands(meta, range, origin, zoom, clipWidthCss);
  }, [meta, range, origin, zoom, clipWidthCss, pyramidRev]);

  if (clipWidthCss < MIN_CLIP_CSS_PX) {
    return null;
  }
  return (
    <div className="clip-waveform" aria-hidden ref={setEl}>
      {tiles.map(({ k, rect }) => (
        <canvas
          key={k}
          className="clip-waveform-tile"
          width={rect.sw}
          height={heightDev}
          style={{ left: rect.left, width: rect.width }}
          ref={(canvas) => {
            if (canvas) {
              canvases.current.set(k, canvas);
            } else {
              canvases.current.delete(k);
            }
          }}
        />
      ))}
      {quiet.map((band) => (
        <span
          key={`q-${band.startSec}-${band.endSec}`}
          className="clip-waveform-quiet"
          style={{
            left: (band.startSec - mediaStartSec) * zoom,
            width: Math.max(1, (band.endSec - band.startSec) * zoom),
          }}
        />
      ))}
    </div>
  );
}

/** Re-renders only for its own primitive props, status, style and tile range. */
export const WaveformLayer = memo(WaveformLayerView);
