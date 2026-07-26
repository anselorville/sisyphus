import type { Meta, StoryObj } from "@storybook/react-vite";
import { ElevationDialog } from "./ElevationDialog";

const meta: Meta<typeof ElevationDialog> = {
  title: "Components/ElevationDialog",
  component: ElevationDialog,
  args: {
    onAllow: () => {},
    onDeny: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ElevationDialog>;

export const Closed: Story = {
  args: { request: null },
};

export const Open: Story = {
  args: {
    request: {
      requestId: "req-1",
      action: "delete the old draft file",
      impact: "local filesystem",
    },
  },
};

export const BookingElevation: Story = {
  args: {
    request: {
      requestId: "req-2",
      action: "book a $450 flight to Tokyo",
      impact: "your linked payment method",
      taskId: "t1",
    },
  },
};

export const LongTextContent: Story = {
  args: {
    request: {
      requestId: "req-3",
      action:
        "send an email to all 12 contacts in your travel group with the finalized itinerary, hotel confirmation numbers, and a request for passport copies within the next 48 hours",
      impact:
        "your contacts' inboxes, and any automatic reply rules or forwarding filters configured on your linked email account",
    },
  },
};

export const NarrowMobile: Story = {
  args: {
    request: {
      requestId: "req-4",
      action: "book a $450 flight to Tokyo with a nonrefundable fare",
      impact: "your linked payment method and existing calendar holds",
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 700, position: "relative" }}>
        <Story />
      </div>
    ),
  ],
};
