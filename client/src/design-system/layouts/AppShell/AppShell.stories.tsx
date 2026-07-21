import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppShell } from "./AppShell";
import { TranscriptLog } from "../../components/TranscriptLog";
import { ConnectButton } from "../../components/ConnectButton";
import { AudioLevelMeter } from "../../components/AudioLevelMeter";
import type { TranscriptEvent } from "../../../hooks/useTranslatorConnection.types";

const meta: Meta<typeof AppShell> = {
  title: "Layouts/AppShell",
  component: AppShell,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: 800, width: 480, margin: "0 auto", border: "1px solid var(--ds-color-border)" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AppShell>;

const entries: TranscriptEvent[] = [
  { kind: "original", id: "1", timestamp: 0, text: "你好，请问最近的车站在哪里？" },
  {
    kind: "translation",
    id: "2",
    timestamp: 1,
    text: "Hello, where is the nearest train station?",
    direction: "ZH->EN",
  },
];

export const Disconnected: Story = {
  args: {
    title: "Sisyphus Translator",
    connectionState: "disconnected",
    onSettingsClick: () => {},
    children: <TranscriptLog entries={[]} />,
    footer: (
      <>
        <ConnectButton connectionState="disconnected" onConnect={() => {}} onDisconnect={() => {}} />
        <AudioLevelMeter level={0} />
      </>
    ),
  },
};

export const Connected: Story = {
  args: {
    title: "Sisyphus Translator",
    connectionState: "connected",
    onSettingsClick: () => {},
    children: <TranscriptLog entries={entries} />,
    footer: (
      <>
        <ConnectButton connectionState="connected" onConnect={() => {}} onDisconnect={() => {}} />
        <AudioLevelMeter level={0.6} />
      </>
    ),
  },
};
