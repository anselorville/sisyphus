import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelProviderScreen } from "./ModelProviderScreen";

const meta: Meta<typeof ModelProviderScreen> = {
  title: "Components/ModelProviderScreen",
  component: ModelProviderScreen,
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
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ModelProviderScreen>;

// NOTE: these stories fetch from a real server address and will show the
// "couldn't reach the server" state in isolated Storybook (no backend
// running) -- same posture as ModelLabScreen's stories. They document the
// component's loading/error UI; the local/cloud mode states (including the
// always-shown, disabled Omni row) are only reachable with a live backend
// serving GET /api/model-providers.
export const Default: Story = {};
