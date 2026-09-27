import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { disambiguatedNames } from "../presence/colors";
import { sessionClient } from "../test/fixtures";
import { AvatarStackView } from "./AvatarStackView";
import { TransportFrame, TransportZone } from "./TransportFrame";

const SELF = sessionClient({
  client_id: "story-self",
  followers: 2,
  meta: { display_name: "You", color_index: 0 },
});
const ADA = sessionClient({
  client_id: "ada",
  meta: { display_name: "Ada", color_index: 1 },
});
const BO = sessionClient({
  client_id: "bo",
  role: "agent",
  meta: { display_name: "Bo", color_index: 2 },
});
const CY = sessionClient({
  client_id: "cy",
  meta: { display_name: "Cy", color_index: 3 },
});
const DI = sessionClient({
  client_id: "di",
  meta: { display_name: "Di", color_index: 4 },
});
const ELI = sessionClient({
  client_id: "eli",
  meta: { display_name: "Eli", color_index: 5 },
});

const NAMES = disambiguatedNames([SELF, ADA, BO, CY, DI, ELI]);

const meta: Meta<typeof AvatarStackView> = {
  title: "Templates/AvatarStack",
  component: AvatarStackView,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => {
      if (context.parameters.avatarHost === "menu") {
        return (
          <div role="menu" aria-label="People" className="ui-menu-panel">
            <Story />
          </div>
        );
      }
      return (
        <>
          <TransportFrame>
            <TransportZone position="end">
              <Story />
            </TransportZone>
          </TransportFrame>
          <main aria-label="Stage" />
        </>
      );
    },
  ],
  args: {
    self: SELF,
    names: NAMES,
    followingClientId: null,
    onFollow: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const Inline: Story = {
  args: {
    others: [ADA, BO],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Follow Ada" }),
    ).toBeInTheDocument();
  },
};

export const Following: Story = {
  args: {
    others: [ADA, BO],
    followingClientId: "ada",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Stop following Ada" }),
    ).toBeInTheDocument();
  },
};

export const Overflow: Story = {
  args: {
    others: [ADA, BO, CY, DI, ELI],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "+2 more" }),
    ).toBeInTheDocument();
    await expect(canvas.getByLabelText("2 following you")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "+2 more" }));
    await expect(
      canvas.getByRole("menuitem", { name: /Di/ }),
    ).toBeInTheDocument();
  },
};

export const PeopleMenu: Story = {
  parameters: { avatarHost: "menu" },
  args: {
    variant: "menu",
    others: [ADA, BO],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("menuitem", { name: /Ada/ }),
    ).toBeInTheDocument();
  },
};

export const PhoneWidth: Story = {
  parameters: {
    avatarHost: "menu",
    viewport: { defaultViewport: "mobile1" },
  },
  args: {
    variant: "menu",
    others: [ADA, BO, CY],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("group", { name: "People" })).toBeTruthy();
  },
};
