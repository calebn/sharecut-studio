import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import { episode, MIRA, selections } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { EditActionBar } from "./EditActionBar";
import { inspectorHeading } from "./inspectorHeading";
import { useTrackSections } from "./trackSections";

function TrackCard({ phone = false }: { phone?: boolean }) {
  const sections: readonly InspectorSection[] =
    useTrackSections(selections.track) ?? [];
  const project = useDawStore((s) => s.project);
  const heading = inspectorHeading(selections.track, project);
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  return (
    <Framed>
      {(bounds) => {
        const anchor = { x: bounds.width * 0.4, y: 72, width: 160, height: 40 };
        return phone ? (
          <InspectorSheet
            form="phone"
            {...heading}
            sections={sections}
            detent={detent}
            onDetentChange={setDetent}
            onDismiss={fn()}
            onClose={fn()}
          />
        ) : (
          <>
            <AnchorMark anchor={anchor} />
            <InspectorSheet
              form="card"
              {...heading}
              sections={sections}
              anchor={anchor}
              bounds={bounds}
              onClose={fn()}
            />
          </>
        );
      }}
    </Framed>
  );
}

const DUCK = "Duck music under speech";
const DUCK_WAIT = { timeout: 5000 };

/** The host's reply to a ducking dry run: one music track, with `earlierDips` old dips to replace. */
function duckReply(changed: boolean, earlierDips = 0) {
  return {
    "POST /api/document/command": {
      command: {
        payload: {
          result: {
            plan_token: "plan-1",
            depth_db: -18,
            dialogue_track_ids: ["dialogue"],
            tracks: [
              {
                track_id: MIRA,
                changed,
                regions: 3,
                points: 12,
                replaced_generated: earlierDips,
                coarsened: false,
              },
            ],
            warnings: [],
            dry_run: true,
            applied: false,
          },
        },
      },
    },
  };
}

const musicProject = () =>
  episode({
    tracks: episode().tracks.map((track) =>
      track.id === MIRA ? { ...track, role: "music" } : track,
    ),
  });

const meta: Meta = {
  title: "Stages/Edit/TrackInspector",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <TrackCard />,
  parameters: {
    ...viewportStoryParameters,
    episode: {
      project: episode(),
      role: "editor",
      selection: selections.track,
    },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The live track body (`useTrackSections`) under the real heading (`inspectorHeading`) in an Inspector card, read from the hydrated episode: the header holds the track's avatar and its name as an inline field, Person and Kind come first, Level is a Scrub field, Mute, Solo and the effect on/off switches write as before; a Viewer link sees the same values read-only.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Track: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Level" }),
    ).toBeVisible();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Mira",
    );
    const kind = canvas.getByRole("group", { name: "Kind" });
    await expect(
      within(kind).getByRole("button", { name: "Voice" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("radio", { name: /Mira/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(canvas.queryByRole("button", { name: DUCK })).toBeNull();
  },
};

export const TrackMusic: Story = {
  parameters: {
    episode: {
      project: episode({
        tracks: episode().tracks.map((track) =>
          track.id === MIRA ? { ...track, role: "music" } : track,
        ),
      }),
      role: "editor",
      selection: selections.track,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Level" }),
    ).toBeVisible();
    const kind = canvas.getByRole("group", { name: "Kind" });
    await expect(
      within(kind).getByRole("button", { name: "Music" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.queryByRole("radiogroup")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Add person" }),
    ).toBeNull();
  },
};

export const TrackMusicDuckReady: Story = {
  parameters: {
    episode: {
      project: musicProject(),
      role: "host",
      selection: selections.track,
      responses: duckReply(true),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Lowers 1 music track by 18 dB while people speak. Your own volume points stay.",
        {},
        DUCK_WAIT,
      ),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: DUCK })).toBeEnabled();
  },
};

export const TrackMusicDuckStale: Story = {
  parameters: {
    episode: {
      project: musicProject(),
      role: "host",
      selection: selections.track,
      responses: duckReply(true, 4),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Ducking may be out of date. Duck again.",
        { selector: "p" },
        DUCK_WAIT,
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Duck again" }),
    ).toBeEnabled();
  },
};

export const TrackMusicDuckCurrent: Story = {
  parameters: {
    episode: {
      project: musicProject(),
      role: "host",
      selection: selections.track,
      responses: duckReply(false, 4),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Music already follows the speech.",
        { selector: "p" },
        DUCK_WAIT,
      ),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: DUCK })).toBeDisabled();
  },
};

export const TrackMusicDuckChecking: Story = {
  parameters: {
    episode: {
      project: musicProject(),
      role: "host",
      selection: selections.track,
      hang: ["POST /api/document/command"],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Checking your music tracks...",
        { selector: "p" },
        DUCK_WAIT,
      ),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: DUCK })).toBeDisabled();
  },
};

export const TrackMusicDuckUnreachable: Story = {
  parameters: {
    episode: {
      project: musicProject(),
      role: "host",
      selection: selections.track,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Could not check the music tracks. You can still duck.",
        {},
        DUCK_WAIT,
      ),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: DUCK })).toBeEnabled();
  },
};

export const TrackMusicDuckPhone: Story = {
  render: () => <TrackCard phone />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: {
      project: musicProject(),
      role: "host",
      selection: selections.track,
      responses: duckReply(true),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Lowers 1 music track by 18 dB while people speak. Your own volume points stay.",
        {},
        DUCK_WAIT,
      ),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: DUCK })).toBeEnabled();
  },
};

export const TrackPhone: Story = {
  render: () => <TrackCard phone />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const TrackReadOnly: Story = {
  parameters: {
    episode: {
      project: episode(),
      role: "viewer",
      selection: selections.track,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Level" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("textbox", { name: "Name" })).toBeNull();
    await expect(canvas.queryByRole("group", { name: "Kind" })).toBeNull();
    await expect(canvas.queryByRole("radiogroup")).toBeNull();
    await expect(canvas.getByText("Voice")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Remove track" }),
    ).toBeNull();
    await expect(canvas.queryByRole("button", { name: DUCK })).toBeNull();
  },
};

export const TrackActionBar: Story = {
  render: () => (
    <Framed>{() => <EditActionBar form="dock" root={null} />}</Framed>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["Hear", "Remove", "More", "Inspect"])
      await expect(await canvas.findByRole("button", { name })).toBeEnabled();
  },
};
