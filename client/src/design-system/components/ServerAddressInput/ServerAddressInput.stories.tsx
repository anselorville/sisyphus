import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ServerAddressInput } from "./ServerAddressInput";

const meta: Meta<typeof ServerAddressInput> = {
  title: "Components/ServerAddressInput",
  component: ServerAddressInput,
};

export default meta;
type Story = StoryObj<typeof ServerAddressInput>;

export const Editable: Story = {
  render: () => {
    const [value, setValue] = useState("http://localhost:7860");
    return <ServerAddressInput value={value} onChange={setValue} />;
  },
};

export const Disabled: Story = {
  args: { value: "http://192.168.1.42:7860", onChange: () => {}, disabled: true },
};

export const Empty: Story = {
  args: { value: "", onChange: () => {} },
};
