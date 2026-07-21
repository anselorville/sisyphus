import type { Meta, StoryObj } from "@storybook/react-vite";
import { FaceToFaceView } from "./FaceToFaceView";
import { LANGUAGES } from "../../../data/languages";
import type { TranscriptEvent } from "../../../hooks/useTranslatorConnection.types";

const meta: Meta<typeof FaceToFaceView> = {
  title: "Components/FaceToFaceView",
  component: FaceToFaceView,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", width: "100vw" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    source: LANGUAGES.find((l) => l.code === "EN")!,
    target: LANGUAGES.find((l) => l.code === "ZH")!,
    onExit: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof FaceToFaceView>;

const transcripts: TranscriptEvent[] = [
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
  args: { transcripts: [], connectionState: "connected" },
};

export const Conversing: Story = {
  args: { transcripts, connectionState: "connected" },
};

export const Disconnected: Story = {
  args: { transcripts: [], connectionState: "disconnected" },
};
