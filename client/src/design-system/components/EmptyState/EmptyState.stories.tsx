import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "Components/EmptyState",
  component: EmptyState,
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Welcome: Story = { args: { variant: "welcome" } };
export const Connecting: Story = { args: { variant: "connecting" } };
export const Error: Story = { args: { variant: "error" } };
export const ErrorWithDetail: Story = {
  args: { variant: "error", detail: "Server responded 502 at http://localhost:7860/api/offer" },
};
