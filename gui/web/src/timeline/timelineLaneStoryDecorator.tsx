import type { Decorator } from "@storybook/react-vite";
import type { CSSProperties } from "react";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { type MarkerRows, markerLaneHeight } from "./timelineMetrics";

function previewLabel(label: unknown, fallback: string): string {
  return typeof label === "string" && label.trim() ? label : fallback;
}

function laneTrackIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
}

/**
 * Production lane shell for prop-only overlay stories at desktop or phone
 * width. Story parameters: `lanePreviewLabel` (landmark name), `phoneWidth`
 * (360px lanes), `laneTrackIds` (one `lane-row` per id with `data-track-id`,
 * the story inside the first) and `reserveRulerRoom` (a ruler-height spacer
 * above the lanes, for chips drawn above the first lane as the live ruler
 * leaves room for).
 */
export const timelineLaneStoryDecorator: Decorator = (Story, context) => {
  const { lanePreviewLabel, phoneWidth, reserveRulerRoom } = context.parameters;
  const label = previewLabel(lanePreviewLabel, "Timeline lane preview");
  const width = phoneWidth ? "360px" : "40rem";
  const ids = laneTrackIds(context.parameters.laneTrackIds);
  const [firstId, ...restIds] = ids.length > 0 ? ids : [undefined];
  return (
    <main className="timeline-area" aria-label={label}>
      {reserveRulerRoom ? (
        <div
          data-story-ruler-room=""
          aria-hidden="true"
          style={{ height: "var(--ruler-height)" }}
        />
      ) : null}
      <div className="lane-row" data-track-id={firstId} style={{ width }}>
        <div className="lane-inner" style={{ width: "100%" }}>
          <Story />
        </div>
      </div>
      {restIds.map((id) => (
        <div
          key={id}
          className="lane-row"
          data-track-id={id}
          style={{ width }}
        />
      ))}
    </main>
  );
};

const ALL_MARKER_ROWS: MarkerRows = {
  chapters: true,
  social: true,
  comments: true,
  clipping: true,
};

/**
 * Marker-row shell: the row sits above the lanes (no `.lane-row`), with the
 * marker CSS vars `TimelineView` sets live, sized from the story's `rows` arg.
 */
export const timelineMarkerStoryDecorator: Decorator = (Story, context) => {
  const rows = (context.args.rows as MarkerRows | undefined) ?? ALL_MARKER_ROWS;
  return (
    <main
      className="timeline-area"
      aria-label={previewLabel(
        context.parameters.lanePreviewLabel,
        "Marker lane preview",
      )}
      style={
        {
          "--marker-row-height": `${MARKER_ROW_HEIGHT}px`,
          "--marker-lane-height": `${markerLaneHeight(rows)}px`,
        } as CSSProperties
      }
    >
      <Story />
    </main>
  );
};
