import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { LanguagePicker } from "./LanguagePicker";
import { LANGUAGES } from "../../../data/languages";

const meta: Meta<typeof LanguagePicker> = {
  title: "Components/LanguagePicker",
  component: LanguagePicker,
  args: {
    label: "Source language",
    value: LANGUAGES[0],
    onChange: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof LanguagePicker>;

export const Default: Story = {};

export const WithDisabledOption: Story = {
  args: { disabledCodes: ["EN"] },
};

export const Interactive: Story = {
  render: () => {
    function Wrapper() {
      const [value, setValue] = useState(LANGUAGES[0]);
      return <LanguagePicker label="Source language" value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};
