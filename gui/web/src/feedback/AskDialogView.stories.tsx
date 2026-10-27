import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { AskDialogView } from "./AskDialogView";
import type { Answer, ConfirmQuestion } from "./ask";

const meta: Meta<typeof AskDialogView> = {
  title: "Organisms/AskDialog",
  component: AskDialogView,
  tags: ["autodocs"],
  parameters: isolatedStoryParameters,
  args: { onAnswer: fn() },
};

export default meta;
type Story = StoryObj<typeof AskDialogView>;

const REMOVE: ConfirmQuestion = {
  kind: "confirm",
  title: "Remove the Host track?",
  message: "Its clips leave the timeline.",
  keepLabel: "Keep track",
  actionLabel: "Remove track",
  danger: true,
};

function Launched({
  question,
  onAnswer,
}: {
  question: ConfirmQuestion;
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
