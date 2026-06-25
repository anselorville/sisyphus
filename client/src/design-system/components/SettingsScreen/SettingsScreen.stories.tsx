import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsScreen } from "./SettingsScreen";
import { LANGUAGES } from "../../../data/languages";

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
    source: LANGUAGES.find((l) => l.code === "ZH")!,
    target: LANGUAGES.find((l) => l.code === "EN")!,
    onSourceChange: () => {},
    onTargetChange: () => {},
    serverAddress: "http://localhost:7860",
    onServerAddressChange: () => {},
    connectionState: "disconnected",
    engineMode: "cloud",
    onClose: () => {},
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

export const Interactive: Story = {
  render: (args) => {
    function Wrapper() {
      const [source, setSource] = useState(args.source);
      const [target, setTarget] = useState(args.target);
      return (
        <SettingsScreen
          {...args}
          source={source}
          target={target}
          onSourceChange={setSource}
          onTargetChange={setTarget}
        />
      );
    }
    return <Wrapper />;
  },
};
