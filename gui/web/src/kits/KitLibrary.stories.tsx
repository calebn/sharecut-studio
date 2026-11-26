import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { LIBRARY } from "../segments/fixtures";
import { SegmentLibrarySheetView } from "../segments/SegmentLibrarySheet";
import {
  studioViewports,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import {
  DAMAGED,
  HEALTHY,
  KITS,
  LONG_NAME,
  UNREADABLE,
  UNUSABLE,
} from "./fixtures";
import { KitLibrary } from "./KitLibrary";
import type { KitLibraryState } from "./useKitLibrary";

function state(over: Partial<KitLibraryState> = {}): KitLibraryState {
  return { rows: KITS, error: null, reload: fn(), ...over };
}

const meta: Meta<typeof KitLibrary> = {
  title: "Stages/Home/KitLibrary",
  component: KitLibrary,
  tags: ["autodocs"],
  args: { library: state() },
  parameters: {
    ...viewportStoryParameters,
    layout: "padded",
    viewport: { options: studioViewports },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Kits section on Home, below the Segment library, and in the Segment library sheet. Each kit shows its name, version and how many segments it holds; More offers Export as file, which saves a .sharecutkit file, named by the studio (<name>.sharecutkit, or <id>.sharecutkit when it names none), or opens the share sheet on a phone. Export is offered only for a kit the studio says is usable. A kit that is not usable, because a segment is missing or cannot be read, stays listed with a warning chip, the studio's own words and a line that it cannot be exported yet, and has no More menu. A kit that cannot be read is listed with its id and problem, with no actions. Host only: guests never see it. Controls are 44 px.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof KitLibrary>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("list", { name: "Saved kits" }),
    ).toBeVisible();
    await expect(canvas.getByText("v3 · 3 versions")).toBeVisible();
    await expect(canvas.getByText("2 segments")).toBeVisible();
  },
};

export const Unusable: Story = {
  args: { library: state({ rows: [HEALTHY, UNUSABLE] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Can't be added to an episode yet"),
    ).toBeVisible();
    await expect(canvas.getByText(UNUSABLE.problem as string)).toBeVisible();
    await expect(
      canvas.getByText(
        "It can't be exported until its segments are back in the library.",
      ),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "More actions for Launch week" }),
    ).toBeNull();
  },
};

export const Unreadable: Story = {
  args: { library: state({ rows: [HEALTHY, UNREADABLE] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(UNREADABLE.problem as string)).toBeVisible();
    await expect(
      canvas.getByText("It can't be exported until that is fixed."),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "More actions for Bumper set" }),
    ).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "More actions for Show Kit" }),
    ).toBeVisible();
  },
};

export const Damaged: Story = {
  args: { library: state({ rows: [HEALTHY, DAMAGED] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Unreadable kit")).toBeVisible();
    await expect(canvas.getByText("Can't be read")).toBeVisible();
    await expect(canvas.getByText(DAMAGED.problem)).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: `More actions for ${DAMAGED.id}` }),
    ).toBeNull();
  },
};

export const Empty: Story = {
  args: { library: state({ rows: [] }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/No kits yet/)).toBeVisible();
  },
};

export const Loading: Story = {
  args: { library: state({ rows: null }) },
};

export const LoadFailed: Story = {
  args: {
    library: state({ rows: null, error: "The studio did not answer." }),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Try again to load the kits",
      }),
    );
    await expect(args.library.reload).toHaveBeenCalledOnce();
  },
};

export const LongNames: Story = {
  args: { library: state({ rows: [LONG_NAME, UNUSABLE, ...KITS] }) },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const Phone: Story = {
  globals: { viewport: { value: "mobile390", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("list", { name: "Saved kits" }),
    ).toBeVisible();
  },
};

export const PhoneUnusable: Story = {
  args: { library: state({ rows: [UNUSABLE, DAMAGED] }) },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Sheet: Story = {
  parameters: { docs: { story: { inline: false, height: "40rem" } } },
  render: (args, context) => (
    <DialogLauncher
      label="Open segment library"
      initiallyOpen={context.viewMode === "story"}
    >
      {(open, close) => (
        <SegmentLibrarySheetView
          open={open}
          onClose={close}
          library={{
            rows: LIBRARY,
            error: null,
            highlightId: null,
            reload: fn(),
            reveal: fn(),
            remove: fn(async () => null),
          }}
          kits={args.library}
        />
      )}
    </DialogLauncher>
  ),
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openDialogByLauncher(canvasElement, {
      launcherName: "Open segment library",
      dialogName: "Segment library",
    });
    await expect(
      within(sheet).getByRole("list", { name: "Saved kits" }),
    ).toBeVisible();
  },
};

export const PhoneSheet: Story = {
  ...Sheet,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
