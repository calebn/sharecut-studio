import { ClipLed } from "./ClipLed";
import {
  ariaValueNow,
  DEFAULT_DANGER_DB,
  DEFAULT_MIN_DB,
  DEFAULT_WARN_DB,
  dbToFraction,
  formatDb,
  type MeterZone,
  zoneForDb,
} from "./metering";

export type LevelMeterOrientation = "horizontal" | "vertical";
export type LevelMeterSize = "sm" | "md";

export type LevelMeterProps = {
  /** Current peak level, dBFS (−Infinity..0). The driver owns ballistics. */
  levelDb: number;
  /** Peak-hold marker, dBFS. Omit (or pass −Infinity) to hide. */
  peakHoldDb?: number;
  /** Latched clip state — stays lit until the driver clears it. */
  clipped?: boolean;
  /** Bottom of the scale, dBFS. */
  minDb?: number;
  /** dBFS where the amber zone starts. */
  warnDb?: number;
  /** dBFS where the red zone starts. */
  dangerDb?: number;
  orientation?: LevelMeterOrientation;
  size?: LevelMeterSize;
  /** dBFS tick labels under/beside the track. */
  showScale?: boolean;
  /** Numeric dBFS readout next to the track. */
  showNumeric?: boolean;
  /** Accessible name, e.g. "Host input". */
  label?: string;
};

const SCALE_TICKS_DB = [0, -10, -20, -30, -40, -50, -60];

/**
 * Scale end labels are pulled inside the track by value, not DOM order, so a
 * `minDb` that isn't a multiple of 10 (e.g. −48) keeps its last tick centered.
 */
function tickEdge(tickDb: number, minDb: number): "max" | "min" | undefined {
  if (tickDb === 0) return "max";
  if (tickDb === minDb) return "min";
  return undefined;
}

function zoneGradient(
  orientation: LevelMeterOrientation,
  warnDb: number,
  dangerDb: number,
  minDb: number,
): string {
  const warnPct = dbToFraction(warnDb, minDb) * 100;
  const dangerPct = dbToFraction(dangerDb, minDb) * 100;
  const dir = orientation === "horizontal" ? "to right" : "to top";
  return (
    `linear-gradient(${dir}, ` +
    `var(--color-success) 0%, var(--color-success) ${warnPct}%, ` +
    `var(--color-warning) ${warnPct}%, var(--color-warning) ${dangerPct}%, ` +
    `var(--color-danger) ${dangerPct}%, var(--color-danger) 100%)`
  );
}

/**
 * Presentational peak meter for recording inputs.
 *
 * Pure: it renders whatever the driver hands it — level, peak hold, and the
 * latched clip flag — so Storybook can show every state without a microphone
 * and the record UI can wire it to `useInputPeakDb`. The root's
 * `data-zone` tints the numeric readout. Zones are real
 * dBFS thresholds, not decoration: green below `warnDb`, amber to
 * `dangerDb`, red above. Red starts before the 0 dBFS ceiling on purpose —
 * by the time a sample hits 0 dBFS the take has already clipped.
 */
export function LevelMeter({
  levelDb,
  peakHoldDb,
  clipped = false,
  minDb = DEFAULT_MIN_DB,
  warnDb = DEFAULT_WARN_DB,
  dangerDb = DEFAULT_DANGER_DB,
  orientation = "horizontal",
  size = "md",
  showScale = false,
  showNumeric = false,
  label = "Input level",
}: LevelMeterProps) {
  const levelFrac = dbToFraction(levelDb, minDb);
  const holdFrac =
    peakHoldDb !== undefined && Number.isFinite(peakHoldDb)
      ? dbToFraction(peakHoldDb, minDb)
      : null;
  const zone: MeterZone = zoneForDb(levelDb, warnDb, dangerDb);
  const gradient = zoneGradient(orientation, warnDb, dangerDb, minDb);

  const fillClip =
    orientation === "horizontal"
      ? `inset(0 ${(1 - levelFrac) * 100}% 0 0)`
      : `inset(${(1 - levelFrac) * 100}% 0 0 0)`;
  const holdStyle =
    holdFrac === null
      ? undefined
      : orientation === "horizontal"
        ? { left: `calc(${holdFrac * 100}% - var(--meter-hold-offset))` }
        : { bottom: `calc(${holdFrac * 100}% - var(--meter-hold-offset))` };

  const valueText = clipped
    ? `Clipping: peak ${formatDb(Math.max(levelDb, peakHoldDb ?? levelDb))}`
    : formatDb(levelDb);

  return (
    <>
      <div
        className={`ui-meter ui-meter--${orientation} ui-meter--${size}`}
        data-zone={zone}
        role="meter"
        aria-label={label}
        aria-valuemin={minDb}
        aria-valuemax={0}
        aria-valuenow={ariaValueNow(levelDb, minDb)}
        aria-valuetext={valueText}
      >
        <div className="ui-meter-main">
          <div className="ui-meter-track" aria-hidden="true">
            <div
              className="ui-meter-fill"
              style={{ background: gradient, clipPath: fillClip }}
            />
            {holdStyle && (
              <div
                className="ui-meter-hold"
                style={holdStyle}
                data-testid="peak-hold"
              />
            )}
          </div>
          {showScale && (
            <div className="ui-meter-scale" aria-hidden="true">
              {SCALE_TICKS_DB.filter((t) => t >= minDb).map((t) => (
                <span
                  key={t}
                  className="ui-meter-tick"
                  data-edge={tickEdge(t, minDb)}
                  style={
                    orientation === "horizontal"
                      ? { left: `${dbToFraction(t, minDb) * 100}%` }
                      : { bottom: `${dbToFraction(t, minDb) * 100}%` }
                  }
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <ClipLed lit={clipped} showText />
        {showNumeric && (
          <span className="ui-meter-numeric" aria-hidden="true">
            {formatDb(levelDb)}
          </span>
        )}
      </div>
      <span className="sr-only" role="status">
        {clipped ? `${label}: clipping` : ""}
      </span>
    </>
  );
}
