import type { Meta, StoryObj } from "@storybook/react-vite";
import { LanguagePairHeader } from "./LanguagePairHeader";
import { ConnectionStatusBadge } from "../ConnectionStatusBadge";
import { LANGUAGES } from "../../../data/languages";

const meta: Meta<typeof LanguagePairHeader> = {
  title: "Components/LanguagePairHeader",
  component: LanguagePairHeader,
  args: {
    source: LANGUAGES[0],
    target: LANGUAGES[1],
    onSwap: () => {},
    onSettingsClick: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof LanguagePairHeader>;

export const Default: Story = {};

export const WithStatus: Story = {
  args: {
    statusSlot: <ConnectionStatusBadge connectionState="connected" />,
  },
};

export const LongNames: Story = {
  args: {
    source: LANGUAGES.find((l) => l.code === "DE")!,
    target: LANGUAGES.find((l) => l.code === "ES")!,
  },
};
