import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsScreen } from "./SettingsScreen";

const meta: Meta<typeof SettingsScreen> = {
  title: "Components/SettingsScreen",
  component: SettingsScreen,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", width: 420, border: "1px solid var(--ds-color-border)" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    serverAddress: "http://localhost:7860",
    onServerAddressChange: () => {},
    connectionState: "disconnected",
    engineMode: "cloud",
    onClose: () => {},
    onOpenModelLab: () => {},
    onOpenModelProvider: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof SettingsScreen>;

export const Default: Story = {};

export const LockedWhileConnected: Story = {
  args: { connectionState: "connected" },
};

export const OfflineEngine: Story = {
  args: { engineMode: "offline" },
};
