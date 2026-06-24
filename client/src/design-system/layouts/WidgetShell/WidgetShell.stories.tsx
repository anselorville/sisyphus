import type { Meta, StoryObj } from "@storybook/react-vite";
import { WidgetShell } from "./WidgetShell";

const meta: Meta<typeof WidgetShell> = {
  title: "Layouts/WidgetShell",
  component: WidgetShell,
};

export default meta;
type Story = StoryObj<typeof WidgetShell>;

export const Disconnected: Story = {
  args: { connectionState: "disconnected" },
};

export const Connecting: Story = {
  args: { connectionState: "connecting" },
};

export const TranslatingNow: Story = {
  args: {
    connectionState: "connected",
    latestTranslation: "Hello, where is the nearest train station?",
  },
};

export const Error: Story = {
  args: { connectionState: "error" },
};
