import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptLog } from "./TranscriptLog";
import type { TranscriptEvent } from "../../../hooks/useTranslatorConnection.types";

const meta: Meta<typeof TranscriptLog> = {
  title: "Components/TranscriptLog",
  component: TranscriptLog,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: 480, width: 420, border: "1px solid var(--ds-color-border)" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TranscriptLog>;

const populated: TranscriptEvent[] = [
  { kind: "original", id: "1", timestamp: 0, text: "你好，请问最近的车站在哪里？" },
  {
    kind: "translation",
    id: "2",
    timestamp: 1,
    text: "Hello, where is the nearest train station?",
    direction: "ZH->EN",
  },
  { kind: "original", id: "3", timestamp: 2, text: "Turn left at the next light." },
  {
    kind: "translation",
    id: "4",
    timestamp: 3,
    text: "在下一个信号灯左转。",
    direction: "EN->ZH",
  },
];

export const Empty: Story = {
  args: { entries: [] },
};

export const Populated: Story = {
  args: { entries: populated },
};

export const MidFlight: Story = {
  args: {
    entries: [
      ...populated,
      { kind: "original", id: "5", timestamp: 4, text: "Where can I exchange currency near here?" },
    ],
  },
};
