import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, FieldRow } from "./index";

const meta: Meta<typeof FieldRow> = {
  title: "Molecules/FieldRow",
  component: FieldRow,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof FieldRow>;

export const Default: Story = {
  render: () => (
    <FieldRow>
      <Field label="Start" htmlFor="sb-start">
        <input id="sb-start" defaultValue="00:12.4" />
      </Field>
      <Field label="End" htmlFor="sb-end">
        <input id="sb-end" defaultValue="00:18.9" />
      </Field>
    </FieldRow>
  ),
};
