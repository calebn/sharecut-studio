import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import { inspectKeyOf } from "../../state/selection";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode, selections } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "../frame/StageFrame";
import { EditWorkspace, type EditWorkspaceProps } from "./EditWorkspace";
import { EDIT_SHEETS } from "./editSheets";

type Args = EditWorkspaceProps & { guestShare?: boolean };

/** Stands in for the stage hosts: Edit mounts only while Edit is the stage. */
function Host(props: EditWorkspaceProps) {
  const stage = useDawStore((s) => s.stage);
  return stage === "edit" ? (
    <EditWorkspace {...props} />
  ) : (
    <p style={{ padding: "var(--space-5)" }}>The {stage} stage goes here.</p>
  );
}

const meta: Meta<Args> = {
  title: "Stages/Edit/Workspace",
  component: EditWorkspace,
  beforeEach: episodeBeforeEach,
  render: ({ guestShare, ...props }) => (
    <StageFrame guestShare={guestShare} sheets={EDIT_SHEETS}>
      <Host guestShare={guestShare} {...props} />
    </StageFrame>
  ),
  decorators: [
    withEpisode,
    (Story) => (
      <div data-daw-app-chrome>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    viewport: { options: studioViewports },
    episode: {},
    docs: {
      description: {
        component:
          "The Edit stage host: the timeline with its track headers, the Script pane, the Inspector and the sheets that hang off them. The corner holds fit, zoom and the Script toggle; the eye opens the View sheet and the + row under the last track adds audio, a track or a chapter.\n\n**Motion.** Nothing in the workspace animates: the Script pane, the divider and the Inspector column change width in one frame. The View and Mix sheets use the system Sheet's own motion (`--motion-hover`, the phone detents).\n\n**Per-stage view.** Zoom and scroll belong to the stage: leaving Edit saves them, coming back restores them. The Script pane's scroll position is saved when the pane unmounts.",
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<Args>;

const WIDE_ONLY_REASON =
  "The play needs the side-by-side desktop workspace and a 360 px viewport selects the phone one.";

const phone = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
} as const;

export const Desktop: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Script" })).toBeVisible();
    await expect(
      canvas.getByRole("separator", { name: "Resize Script" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("group", { name: "Timeline view" }),
    ).toBeVisible();
  },
};

export const SwitchAndReturn: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Zoom in" }),
    );
    const zoomed = useDawStore.getState().zoomPxPerSec;
    const stages = canvas.getAllByRole("tablist", { name: "Stages" })[0];
    await userEvent.click(within(stages).getByRole("tab", { name: /Review/ }));
    await waitFor(() =>
      expect(canvasElement.querySelector(".timeline-scroll")).toBeNull(),
    );
    await userEvent.click(within(stages).getByRole("tab", { name: /Edit/ }));
    await waitFor(() =>
      expect(canvasElement.querySelector(".timeline-scroll")).not.toBeNull(),
    );
    await expect(useDawStore.getState().zoomPxPerSec).toBe(zoomed);
    await expect(useDawStore.getState().userZoomed).toBe(true);
  },
};

export const EyeSheet: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "View options" }),
    );
    await waitFor(() => expect(useDawStore.getState().openSheet).toBe("view"));
    const sheet = await within(document.body).findByRole("dialog", {
      name: "View",
    });
    // The sheet fades in; wait out the entry animation before asserting.
    await waitFor(() =>
      expect(
        within(sheet).getByRole("region", { name: "Layers" }),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(
        within(sheet).getByRole("region", { name: "Waveform scale" }),
      ).toBeVisible(),
    );
  },
};

export const WithInspector: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason: WIDE_ONLY_REASON,
    // Inspect opened it: a selection alone never does.
    episode: {
      selection: selections.track,
      state: { inspectorKey: inspectKeyOf(selections.track) },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector(".edit-inspector")).not.toBeNull(),
    );
  },
};

export const WithActionBar: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason: WIDE_ONLY_REASON,
    episode: { selection: selections.exactRange },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await canvas.findByRole("group", {
      name: "Selection actions",
    });
    await expect(bar).toBeVisible();
    // Selecting alone verbs the object, but opens no Inspector.
    await expect(
      within(bar).getByRole("button", { name: "Cut" }),
    ).toBeVisible();
    await expect(canvasElement.querySelector(".edit-inspector")).toBeNull();
  },
};

export const ScriptCollapsed: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason: WIDE_ONLY_REASON,
    episode: { state: { scriptCollapsed: true } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Script" })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Show or hide Script" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const ScriptFocus: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason: WIDE_ONLY_REASON,
    episode: { state: { scriptFocus: true } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Script" }),
    ).toBeVisible();
    await expect(
      canvasElement.querySelector<HTMLElement>(".edit-timeline-col")?.hidden,
    ).toBe(true);
  },
};

export const TabletStacked: Story = {
  globals: { viewport: { value: "tablet", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  parameters: {
    episode: {
      project: episode({
        tracks: [],
        clips: { tracks: {}, clip_count: 0 },
        timeline_duration_sec: 0,
        transcript: { utterances: [] },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Drop audio files here/,
      }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null, editSurface: "lanes" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("group", { name: "Tracks" }),
    ).toHaveAttribute("aria-busy", "true");
  },
};

export const ScriptError: Story = {
  args: {
    loadFailure: { message: "The server did not answer.", onRetry: fn() },
  },
  parameters: { episode: { state: { editSurface: "text" } } },
  play: async ({ args, canvasElement }) => {
    const pane = await within(canvasElement).findByRole("region", {
      name: "Script",
    });
    await userEvent.click(within(pane).getByRole("button", { name: "Retry" }));
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};

// jsdom has no media queries, so only a real phone viewport mounts the phone surface.
const onPhone = (el: HTMLElement) =>
  el.querySelector(".edit-workspace--phone") !== null;

export const PhoneTimeline: Story = {
  ...phone,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(
      canvas.getByRole("group", { name: "Edit surface" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("group", { name: "Timeline view" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Timeline" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const PhoneScript: Story = {
  ...phone,
  parameters: { episode: { state: { editSurface: "text" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("region", { name: "Script" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await expect(
      canvas.getByRole("button", { name: "Script" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Timeline" }));
    await waitFor(() =>
      expect(useDawStore.getState().editSurface).toBe("lanes"),
    );
  },
};

export const PhoneMix: Story = {
  ...phone,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    if (!onPhone(canvasElement)) return;
    await userEvent.click(canvas.getByRole("button", { name: "Mix" }));
    await waitFor(() => expect(useDawStore.getState().openSheet).toBe("mix"));
  },
};

export const GuestEditor: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "editor" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Fit session width" }),
    ).toBeEnabled();
  },
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: {
    episode: { role: "viewer" },
    docs: {
      description: {
        story:
          "A view link reaches Edit only by a deep link, which the stage host will turn into the cover. The workspace itself stays read-only: no + row, and Alt-click shows no split guide.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "+" })).toBeNull();
  },
};
