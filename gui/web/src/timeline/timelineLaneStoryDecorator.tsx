import type { Decorator } from "@storybook/react-vite";

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
  const previewLabel =
    typeof lanePreviewLabel === "string" && lanePreviewLabel.trim()
      ? lanePreviewLabel
      : "Timeline lane preview";
  const width = phoneWidth ? "360px" : "40rem";
  const ids = laneTrackIds(context.parameters.laneTrackIds);
  const [firstId, ...restIds] = ids.length > 0 ? ids : [undefined];
  return (
    <main className="timeline-area" aria-label={previewLabel}>
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
