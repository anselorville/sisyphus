import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentStatusStrip } from "./AgentStatusStrip";

const meta: Meta<typeof AgentStatusStrip> = {
  title: "Components/AgentStatusStrip",
  component: AgentStatusStrip,
  args: {
    connectionState: "connected",
    ecologyBand: "prosperous",
  },
};

export default meta;
type Story = StoryObj<typeof AgentStatusStrip>;

export const Idle: Story = {
  args: { activity: "idle" },
};

export const Listening: Story = {
  args: { activity: "listening", detail: "Turn open" },
};

export const Speaking: Story = {
  args: { activity: "speaking", detail: "Reading back your itinerary" },
};

export const Working: Story = {
  args: { activity: "working", detail: "2 tasks running" },
};

export const Hibernating: Story = {
  args: { activity: "hibernating", ecologyBand: "hibernating", detail: "Usage exhausted" },
};

export const ProsperousEcology: Story = {
  args: { activity: "idle", ecologyBand: "prosperous" },
};

export const ConservingEcology: Story = {
  args: { activity: "working", ecologyBand: "conserving", detail: "1 task running" },
};

export const ReserveEcology: Story = {
  args: { activity: "working", ecologyBand: "reserve", detail: "Prioritizing important tasks" },
};

export const UnknownEcology: Story = {
  args: { activity: "idle", ecologyBand: "unknown" },
};

export const Disconnected: Story = {
  args: { connectionState: "disconnected", activity: "idle" },
};

export const LongDetailText: Story = {
  args: {
    activity: "working",
    detail:
      "Coordinating 4 background tasks across 3 roles while researching flight options, hotel availability, and local weather forecasts",
  },
};

export const NarrowMobile: Story = {
  args: { activity: "working", detail: "Coordinating 4 background tasks across 3 roles" },
  decorators: [
    (Story) => (
      <div style={{ width: 390 }}>
        <Story />
      </div>
    ),
  ],
};
