import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelLabScreen } from "./ModelLabScreen";

const meta: Meta<typeof ModelLabScreen> = {
  title: "Components/ModelLabScreen",
  component: ModelLabScreen,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", width: 420, border: "1px solid var(--ds-color-border)" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    serverAddress: "http://localhost:7860",
    engineMode: "local-dev",
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ModelLabScreen>;

// NOTE: these stories fetch from a real server address and will show the
// "couldn't reach the server" state in isolated Storybook (no backend
// running) -- documents the component's error-state UI, same posture as
// LocalModelsControl's stories.
export const Default: Story = {};

export const CloudEngine: Story = {
  args: { engineMode: "cloud" },
};
