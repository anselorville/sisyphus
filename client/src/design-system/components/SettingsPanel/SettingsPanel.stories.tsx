import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPanel } from "./SettingsPanel";

const meta: Meta<typeof SettingsPanel> = {
  title: "Components/SettingsPanel",
  component: SettingsPanel,
  args: {
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof SettingsPanel>;

export const Disconnected: Story = {
  render: () => {
    const [value, setValue] = useState("http://localhost:7860");
    return (
      <SettingsPanel
        serverAddress={value}
        onServerAddressChange={setValue}
        connectionState="disconnected"
        onClose={() => {}}
      />
    );
  },
};

export const Connected: Story = {
  args: {
    serverAddress: "http://192.168.1.42:7860",
    onServerAddressChange: () => {},
    connectionState: "connected",
  },
};
