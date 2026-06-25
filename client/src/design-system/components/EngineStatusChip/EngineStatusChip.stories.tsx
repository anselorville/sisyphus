import type { Meta, StoryObj } from "@storybook/react-vite";
import { EngineStatusChip } from "./EngineStatusChip";

const meta: Meta<typeof EngineStatusChip> = {
  title: "Components/EngineStatusChip",
  component: EngineStatusChip,
};

export default meta;
type Story = StoryObj<typeof EngineStatusChip>;

export const Cloud: Story = { args: { mode: "cloud" } };
export const Offline: Story = { args: { mode: "offline" } };
export const LocalDev: Story = { args: { mode: "local-dev" } };
export const Unknown: Story = { args: { mode: "unknown" } };
