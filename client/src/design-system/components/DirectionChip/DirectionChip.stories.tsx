import type { Meta, StoryObj } from "@storybook/react-vite";
import { DirectionChip } from "./DirectionChip";

const meta: Meta<typeof DirectionChip> = {
  title: "Components/DirectionChip",
  component: DirectionChip,
};

export default meta;
type Story = StoryObj<typeof DirectionChip>;

export const ZhToEn: Story = { args: { direction: "ZH->EN" } };
export const EnToZh: Story = { args: { direction: "EN->ZH" } };
export const Missing: Story = { args: { direction: undefined } };
export const Malformed: Story = { args: { direction: "garbled-input" } };
