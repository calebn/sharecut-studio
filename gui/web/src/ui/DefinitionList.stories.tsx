import type { Meta, StoryObj } from "@storybook/react-vite";
import { DefItem, DefinitionList } from "./index";

const meta: Meta<typeof DefinitionList> = {
  title: "Molecules/DefinitionList",
  component: DefinitionList,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof DefinitionList>;

export const Default: Story = {
  render: () => (
    <DefinitionList>
      <DefItem label="Duration">42:17</DefItem>
      <DefItem label="Sample rate">48 kHz</DefItem>
      <DefItem label="Tracks">2</DefItem>
    </DefinitionList>
  ),
};
