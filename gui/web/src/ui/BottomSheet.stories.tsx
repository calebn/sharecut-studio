import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ModifierInspector } from "../inspector/ModifierInspector";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import {
  enlargedLandscapeSheet,
  inspectorSheetStoryDecorator,
} from "../test/inspectorSheetDecorator";
import { openDialogByLauncher } from "../test/storyDialog";
import { BottomSheet, Button } from "./index";

const meta: Meta<typeof BottomSheet> = {
  title: "Organisms/BottomSheet",
  component: BottomSheet,
  tags: ["autodocs"],
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Transient bottom sheet for phone/tablet inspector and quick actions. " +
          "Preview at a narrow viewport to see its intended context.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof BottomSheet>;

function DemoSheet({
  title,
  backgroundPolicy,
}: {
  title?: string;
  backgroundPolicy: "interactive" | "dismiss";
}) {
  return (
    <DialogLauncher label="Open sheet" initiallyOpen={false}>
      {(open, close) => (
        <BottomSheet
          open={open}
          onClose={close}
          backgroundPolicy={backgroundPolicy}
          title={title}
        >
          <p style={{ color: "var(--color-text-secondary)" }}>
            Sheet content goes here — quick actions or the tablet/phone
            inspector.
          </p>
          <Button onClick={close}>Done</Button>
        </BottomSheet>
      )}
    </DialogLauncher>
  );
}

export const Default: Story = {
  args: { backgroundPolicy: "interactive" },
  render: () => <DemoSheet title="Inspector" backgroundPolicy="interactive" />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Open sheet",
      dialogName: "Inspector",
    });
  },
};

export const DismissOutside: Story = {
  render: () => (
    <DemoSheet title="Confirm blade cut" backgroundPolicy="dismiss" />
  ),
};

export const Untitled: Story = {
  render: () => <DemoSheet backgroundPolicy="interactive" />,
};

function ResizableContent() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open long content sheet</Button>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        backgroundPolicy="interactive"
        title="A deliberately long title that wraps across the sheet header"
        expanded={expanded}
        onExpandedChange={setExpanded}
      >
        <p>
          This generic content demonstrates how the sheet body scrolls while its
          header stays available.
        </p>
        <label>
          Include details
          <input type="checkbox" defaultChecked />
        </label>
        <label>
          Detail level
          <input type="range" min="1" max="5" defaultValue="3" />
        </label>
        <p>
          The first note stays with the selection while you review the
          surrounding timeline. It can be read without changing the project or
          dismissing the sheet.
        </p>
        <p>
          A second note gives the body enough ordinary text to demonstrate its
          own scroll area. The title and actions remain in the pinned header as
          this content moves.
        </p>
        <p>
          Additional notes can continue below the fold. Expand provides more
          room when needed, and Close returns to the editor from the same
          visible control.
        </p>
      </BottomSheet>
    </>
  );
}

export const ControlledResizeWithNativeControls: Story = {
  render: () => <ResizableContent />,
  parameters: {
    docs: {
      description: {
        story:
          "A controlled half/full sheet with a long title and native form controls.",
      },
    },
  },
};

export const InspectorEnlargedTextShortLandscape: Story = {
  ...enlargedLandscapeSheet,
  decorators: [inspectorSheetStoryDecorator],
  render: () => (
    <ModifierInspector
      badge="Clip"
      title="A long selected clip name"
      subtitle="Timeline clip details"
      error="The clip changed while editing. Review its latest values and try again."
      primaryActions={[{ label: "Done", onClick: () => {} }]}
    >
      <p>
        The entire inspector, including its heading, fields, error and actions,
        shares one ordinary scroll area.
      </p>
      <label>
        Time on timeline
        <input type="number" defaultValue="2" />
      </label>
      <Button>Save changes</Button>
    </ModifierInspector>
  ),
};
