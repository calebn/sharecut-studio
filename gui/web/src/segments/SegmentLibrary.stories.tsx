import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  studioViewports,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { DAMAGED, LIBRARY, LONG_NAME } from "./fixtures";
import { SegmentLibrary } from "./SegmentLibrary";
import { SegmentLibrarySheetView } from "./SegmentLibrarySheet";
import type { SegmentLibraryState } from "./useSegmentLibrary";

function state(over: Partial<SegmentLibraryState> = {}): SegmentLibraryState {
  return {
    rows: LIBRARY,
    error: null,
    reload: fn(),
    remove: fn(async () => null),
    ...over,
  };
}

const meta: Meta<typeof SegmentLibrary> = {
  title: "Stages/Home/SegmentLibrary",
  component: SegmentLibrary,
  tags: ["autodocs"],
  args: { library: state(), layout: "table" },
  parameters: {
    ...viewportStoryParameters,
    layout: "padded",
    viewport: { options: studioViewports },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Segment library on Home, after Recent: a real table on a wide Home and a list on a narrow one. Play auditions one segment at a time and Stop ends it; More offers Remove, which asks first, says that every version goes and that it can't be undone, and keeps focus on Keep. A segment that cannot be read is listed with its id and problem, with Remove only. Controls are 44 px.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SegmentLibrary>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("table", { name: "Segment library" }),
    ).toBeVisible();
    await expect(canvas.getByText("v3 · 3 versions")).toBeVisible();
  },
};

export const Playing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Play Cold open" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Stop Cold open" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop Cold open" }),
    );
  },
};

export const Empty: Story = {
  args: { library: state({ rows: [] }) },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/No saved segments yet/),
    ).toBeVisible();
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
        name: "Try again to load the segment library",
      }),
    );
    await expect(args.library.reload).toHaveBeenCalledOnce();
  },
};

export const Damaged: Story = {
  args: { library: state({ rows: [LIBRARY[0], DAMAGED] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Can't be played or inserted")).toBeVisible();
    await expect(canvas.getByText(DAMAGED.problem)).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: `Play ${DAMAGED.id}` }),
    ).toBeNull();
  },
};

export const ConfirmRemove: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", {
        name: "More actions for Acme sponsor read",
      }),
    );
    await userEvent.click(
      await within(document.body).findByRole("menuitem", {
        name: "Remove from library",
      }),
    );
    const confirm = canvas.getByRole("group", {
      name: /Remove “Acme sponsor read”/,
    });
    await expect(
      within(confirm).getByRole("button", { name: "Keep" }),
    ).toHaveFocus();
  },
};

export const LongNames: Story = {
  args: { library: state({ rows: [LONG_NAME, ...LIBRARY] }), layout: "list" },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const Phone: Story = {
  args: { layout: "list" },
  globals: { viewport: { value: "mobile390", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("list", { name: "Segment library" }),
    ).toBeVisible();
  },
};

export const PhoneEmpty: Story = {
  args: { library: state({ rows: [] }), layout: "list" },
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
          library={args.library}
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
      within(sheet).getByRole("list", { name: "Segment library" }),
    ).toBeVisible();
  },
};

export const PhoneSheet: Story = {
  ...Sheet,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
