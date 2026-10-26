import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useRef, useState } from "react";
import { expect, fn, within } from "storybook/test";
import { portaledOverlayParameters } from "../storybook/storyLayout";
import { hitRouterStub } from "../test/hitRouterStub";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import type { HitCandidate } from "./hitCandidates";
import { hitTargetProps, type ResolvedHit } from "./hitTargets";
import type { HitKind } from "./inputContract";
import { TargetChooser } from "./TargetChooser";

type Spec = {
  kind: HitKind;
  id: string;
  x: number;
  timeSec: number;
  detail?: string;
  selected?: boolean;
};

const specs: Spec[] = [
  { kind: "fade-in", id: "clip-mira", x: 150, timeSec: 20.4 },
  { kind: "trim-in", id: "clip-mira", x: 160, timeSec: 20.4, selected: true },
  {
    kind: "envelope-point",
    id: "point-2",
    x: 175,
    timeSec: 20.6,
    detail: "0.72",
  },
  { kind: "comment", id: "comment-1", x: 190, timeSec: 20.9, detail: "Tomas" },
  { kind: "chapter", id: "The harbor depot", x: 205, timeSec: 21.2 },
  { kind: "social-clip", id: "social-1", x: 220, timeSec: 21.5 },
];

function candidate(spec: Spec, index: number): HitCandidate {
  return {
    kind: spec.kind,
    id: spec.id,
    x: spec.x,
    y: 180,
    distance: index * 4,
    priority: 10 - index,
    selected: spec.selected ?? false,
  };
}

function ChooserPreview({
  count,
  over,
  fingerDown,
}: {
  count: number;
  over: number | "more" | null;
  fingerDown: boolean;
}) {
  const used = specs.slice(0, count);
  const lane = useRef<HTMLDivElement>(null);
  const [elements, setElements] = useState<Element[]>([]);
  useLayoutEffect(() => {
    setElements(Array.from(lane.current?.children ?? []));
  }, []);
  const hits: ResolvedHit[] = elements.map((element, index) => ({
    candidate: candidate(used[index], index),
    element,
  }));
  return (
    <>
      <div
        ref={lane}
        className="lane-row"
        style={{ inlineSize: "min(40rem, 100%)" }}
      >
        {used.map((spec) => (
          <span
            key={spec.id + spec.kind}
            {...hitTargetProps(spec.kind, spec.id, spec.timeSec, {
              detail: spec.detail,
              selected: spec.selected,
            })}
          />
        ))}
      </div>
      {elements.length === used.length ? (
        <TargetChooser
          view={{
            origin: { x: 180, y: 200 },
            hits,
            page: 0,
            fingerDown,
            over,
            armed: false,
          }}
          router={hitRouterStub()}
          bounds={{ left: 0, top: 0, right: 1000, bottom: 600 }}
          closing={false}
          onClosed={fn()}
        />
      ) : null}
    </>
  );
}

const meta: Meta = {
  title: "Templates/TargetChooser",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: {
    ...portaledOverlayParameters,
    layout: "fullscreen",
    episode: {},
  },
};

export default meta;
type Story = StoryObj;

export const Three: Story = {
  render: () => <ChooserPreview count={3} over={null} fingerDown={false} />,
  play: async () => {
    const menu = await within(document.body).findByRole("menu", {
      name: "Targets here",
    });
    await expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
  },
};

export const FingerOverChip: Story = {
  render: () => <ChooserPreview count={3} over={1} fingerDown />,
  play: async () => {
    const menu = await within(document.body).findByRole("menu");
    await expect(within(menu).getAllByRole("menuitemradio")[1]).toHaveClass(
      "is-over",
    );
  },
};

export const MoreThanFit: Story = {
  render: () => <ChooserPreview count={6} over={null} fingerDown={false} />,
  play: async () => {
    const menu = await within(document.body).findByRole("menu");
    await expect(
      within(menu).getByRole("menuitem", { name: /More targets/ }),
    ).toBeVisible();
  },
};
