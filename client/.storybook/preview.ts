import "../src/design-system/tokens/tokens.css";
import "../src/design-system/fonts/fonts.css";
import "../src/design-system/global/reset.css";

import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
  },
};

export default preview;
