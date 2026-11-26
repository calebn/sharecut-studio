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
import { DAMAGED, HEALTHY, KITS, LONG_NAME, UNUSABLE } from "./fixtures";
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
          "The Kits section on Home, below the Segment library, and in the Segment library sheet. Each kit shows its name, version and how many segments it holds; More offers Export as file, which saves a .sharecutkit file (or opens the share sheet on a phone). A kit with a missing segment stays listed with a warning chip and the studio's own words, and can still be exported. A kit that cannot be read is listed with its id and problem, with no actions. Host only: guests never see it. Controls are 44 px.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof KitLibrary>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("list", { name: "Kits" })).toBeVisible();
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
      canvas.getByRole("button", { name: "More actions for Launch week" }),
    ).toBeVisible();
  },
};

export const Damaged: Story = {
  args: { library: state({ rows: [HEALTHY, DAMAGED] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
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
      within(canvasElement).getByRole("list", { name: "Kits" }),
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
      within(sheet).getByRole("list", { name: "Kits" }),
    ).toBeVisible();
  },
};

export const PhoneSheet: Story = {
  ...Sheet,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
