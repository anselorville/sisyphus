import type { Meta, StoryObj } from "@storybook/react-vite";
import { EcologyPanel } from "./EcologyPanel";

const meta: Meta<typeof EcologyPanel> = {
  title: "Components/EcologyPanel",
  component: EcologyPanel,
  args: {
    sidecarConnected: true,
  },
};

export default meta;
type Story = StoryObj<typeof EcologyPanel>;

export const Prosperous: Story = {
  args: { ecology: "prosperous", food: "prosperous" },
};

export const Conserving: Story = {
  args: { ecology: "conserving", food: "conserving" },
};

export const Reserve: Story = {
  args: { ecology: "reserve", food: "reserve" },
};

export const Hibernating: Story = {
  args: { ecology: "hibernating", food: "hibernating" },
};

export const MixedBands: Story = {
  args: { ecology: "prosperous", food: "reserve" },
};

export const Unknown: Story = {
  args: { ecology: "unknown", food: "unknown", sidecarConnected: false },
};

export const SidecarDisconnectedButLastKnownGood: Story = {
  args: { ecology: "conserving", food: "prosperous", sidecarConnected: false },
};

export const NarrowMobile: Story = {
  args: { ecology: "conserving", food: "reserve" },
  decorators: [
    (Story) => (
      <div style={{ width: 390 }}>
        <Story />
      </div>
    ),
  ],
};
