import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptEntry } from "./TranscriptEntry";

const meta: Meta<typeof TranscriptEntry> = {
  title: "Components/TranscriptEntry",
  component: TranscriptEntry,
};

export default meta;
type Story = StoryObj<typeof TranscriptEntry>;

export const Original: Story = {
  args: {
    entry: { kind: "original", id: "1", timestamp: 0, text: "你好，请问最近的车站在哪里？" },
  },
};

export const Translation: Story = {
  args: {
    entry: {
      kind: "translation",
      id: "2",
      timestamp: 0,
      text: "Hello, where is the nearest train station?",
      direction: "ZH->EN",
    },
  },
};

export const TranslationMissingDirection: Story = {
  args: {
    entry: {
      kind: "translation",
      id: "3",
      timestamp: 0,
      text: "Hello, where is the nearest train station?",
    },
  },
};

export const TranslationMalformedDirection: Story = {
  args: {
    entry: {
      kind: "translation",
      id: "4",
      timestamp: 0,
      text: "Hello, where is the nearest train station?",
      direction: "garbled",
    },
  },
};
