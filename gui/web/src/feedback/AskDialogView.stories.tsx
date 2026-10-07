import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { AskDialogView } from "./AskDialogView";
import type { Answer, Question } from "./ask";

const meta: Meta<typeof AskDialogView> = {
  title: "Organisms/AskDialog",
  component: AskDialogView,
  tags: ["autodocs"],
  parameters: isolatedStoryParameters,
  args: { onAnswer: fn() },
};

export default meta;
type Story = StoryObj<typeof AskDialogView>;

const REMOVE: Question = {
  kind: "confirm",
  title: "Remove the Host track?",
  message: "Its clips leave the timeline.",
  keepLabel: "Keep track",
  actionLabel: "Remove track",
  danger: true,
};

const OPEN: Question = {
  kind: "text",
  title: "Open project",
  label: "Path to episode.project.json",
  hint: "The file picker is not available here.",
  submitLabel: "Open project",
  requiredMessage: "Enter the path to an episode.project.json file.",
};

function Launched({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (answer: Answer) => void;
}) {
  return (
    <DialogLauncher label="Ask" initiallyOpen={false}>
      {(open, close) => (
        <AskDialogView
          question={open ? question : null}
          onAnswer={(answer) => {
            onAnswer(answer);
            close();
          }}
        />
      )}
    </DialogLauncher>
  );
}

export const Confirm: Story = {
  render: (args) => <Launched question={REMOVE} onAnswer={args.onAnswer} />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Ask",
      dialogName: REMOVE.title,
    });
  },
};

export const TextPrompt: Story = {
  render: (args) => <Launched question={OPEN} onAnswer={args.onAnswer} />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Ask",
      dialogName: OPEN.title,
    });
  },
};
