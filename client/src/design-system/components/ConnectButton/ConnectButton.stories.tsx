import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectButton } from "./ConnectButton";

const meta: Meta<typeof ConnectButton> = {
  title: "Components/ConnectButton",
  component: ConnectButton,
  args: {
    onConnect: () => {},
    onDisconnect: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ConnectButton>;

export const Disconnected: Story = {
  args: { connectionState: "disconnected" },
};

export const Connecting: Story = {
  args: { connectionState: "connecting" },
};

export const Connected: Story = {
  args: { connectionState: "connected" },
};

export const Error: Story = {
  args: { connectionState: "error" },
};
