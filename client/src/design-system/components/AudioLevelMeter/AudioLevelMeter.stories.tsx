import type { Meta, StoryObj } from "@storybook/react-vite";
import { AudioLevelMeter } from "./AudioLevelMeter";

const meta: Meta<typeof AudioLevelMeter> = {
  title: "Components/AudioLevelMeter",
  component: AudioLevelMeter,
};

export default meta;
type Story = StoryObj<typeof AudioLevelMeter>;

export const Silent: Story = { args: { level: 0 } };
export const Low: Story = { args: { level: 0.3 } };
export const Mid: Story = { args: { level: 0.7 } };
export const Peak: Story = { args: { level: 1.0 } };
