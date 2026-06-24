import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";

const meta: Meta<typeof ConnectionStatusBadge> = {
  title: "Components/ConnectionStatusBadge",
  component: ConnectionStatusBadge,
};

export default meta;
type Story = StoryObj<typeof ConnectionStatusBadge>;

export const Disconnected: Story = { args: { connectionState: "disconnected" } };
export const Connecting: Story = { args: { connectionState: "connecting" } };
export const Connected: Story = { args: { connectionState: "connected" } };
export const Error: Story = { args: { connectionState: "error" } };
