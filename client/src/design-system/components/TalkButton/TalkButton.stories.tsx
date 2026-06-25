import type { Meta, StoryObj } from "@storybook/react-vite";
import { TalkButton } from "./TalkButton";

const meta: Meta<typeof TalkButton> = {
  title: "Components/TalkButton",
  component: TalkButton,
  args: {
    onConnect: () => {},
    onDisconnect: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof TalkButton>;

export const Disconnected: Story = {
  args: { connectionState: "disconnected", level: 0 },
};

export const Connecting: Story = {
  args: { connectionState: "connecting", level: 0 },
};

export const ConnectedQuiet: Story = {
  args: { connectionState: "connected", level: 0.05 },
};

export const ConnectedSpeaking: Story = {
  args: { connectionState: "connected", level: 0.75 },
};

export const Error: Story = {
  args: { connectionState: "error", level: 0 },
};
