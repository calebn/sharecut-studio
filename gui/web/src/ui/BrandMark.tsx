import type { ReactElement } from "react";
import {
  LOCKUP_GLYPH_TRANSFORM,
  LOCKUP_SYMBOL_TRANSFORM,
  LOCKUP_VIEWBOX,
  LOCKUP_WORDMARK_TRANSFORM,
  SYMBOL_PATHS,
  SYMBOL_VIEWBOX,
  WORDMARK_GLYPHS,
} from "./brand/lockupGeometry";

const symbolShapes = SYMBOL_PATHS.map((path) => (
  <path key={path.id} className={`brand-tone-${path.tone}`} d={path.d} />
));

/** The Two tracks symbol on its own. Decorative: pair it with the product name as text. */
export function BrandSymbol({
  className,
}: {
  className?: string;
}): ReactElement {
  return (
    <svg
      className={className ? `brand-symbol ${className}` : "brand-symbol"}
      viewBox={SYMBOL_VIEWBOX}
      aria-hidden="true"
      focusable="false"
    >
      {symbolShapes}
    </svg>
  );
}

/**
 * The ShareCut lockup: symbol plus outlined wordmark, coloured by the theme's text and
 * accent tokens. The visible name is "ShareCut" with no "Studio"; the product name stays
 * available to assistive tech as text, so the artwork itself is hidden from it.
 */
export function BrandLockup({
  name,
  className,
}: {
  name: string;
  className?: string;
}): ReactElement {
  return (
    <>
      <svg
        className={className ? `brand-lockup ${className}` : "brand-lockup"}
        viewBox={LOCKUP_VIEWBOX}
        aria-hidden="true"
        focusable="false"
      >
        <g transform="translate(20 20)">
          <g transform={LOCKUP_SYMBOL_TRANSFORM}>{symbolShapes}</g>
          <g className="brand-tone-ink" transform={LOCKUP_WORDMARK_TRANSFORM}>
            <g transform={LOCKUP_GLYPH_TRANSFORM}>
              {WORDMARK_GLYPHS.map((glyph) => (
                <path
                  key={glyph.x}
                  transform={`translate(${glyph.x} 0)`}
                  d={glyph.d}
                />
              ))}
            </g>
          </g>
        </g>
      </svg>
      <span className="brand-lockup-name">{name}</span>
    </>
  );
}
