import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentTask } from "../../../hooks/useAgentTasks";
import { TaskNestPanel } from "./TaskNestPanel";

const meta: Meta<typeof TaskNestPanel> = {
  title: "Components/TaskNestPanel",
  component: TaskNestPanel,
  args: {
    onCancel: () => {},
    onSteer: () => {},
    onFollowUp: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof TaskNestPanel>;

function task(overrides: Partial<AgentTask> & Pick<AgentTask, "id" | "goal" | "status">): AgentTask {
  return { updatedAt: Date.now(), ...overrides };
}

export const Empty: Story = {
  args: { tasks: [] },
};

export const SingleRunning: Story = {
  args: {
    tasks: [task({ id: "t1", goal: "Book a flight to Tokyo", status: "running", detail: "Searching flights" })],
  },
};

export const MultipleRunningAndQueued: Story = {
  args: {
    tasks: [
      task({ id: "t1", goal: "Book a flight to Tokyo", status: "running", detail: "Comparing 3 airlines" }),
      task({ id: "t2", goal: "Reserve a hotel near Shibuya", status: "assigned", roleId: "role-concierge" }),
      task({ id: "t3", goal: "Draft a packing list", status: "pending" }),
      task({ id: "t4", goal: "Check the weather forecast for next week", status: "pending" }),
    ],
  },
};

export const WithBlockedTask: Story = {
  args: {
    tasks: [
      task({ id: "t1", goal: "Renew passport", status: "blocked", detail: "Waiting on elevation approval" }),
    ],
  },
};

export const WithRecentlyFinished: Story = {
  args: {
    tasks: [
      task({ id: "t1", goal: "Book a flight to Tokyo", status: "running", detail: "Comparing 3 airlines" }),
      task({ id: "t2", goal: "Check today's weather", status: "completed", detail: "Sunny, 24°C" }),
      task({ id: "t3", goal: "Look up train timetable", status: "failed", detail: "Timetable site unreachable" }),
      task({ id: "t4", goal: "Cancel old reminder", status: "cancelled" }),
    ],
  },
};

export const LongTextContent: Story = {
  args: {
    tasks: [
      task({
        id: "t1",
        goal:
          "Research and compare flight options across at least five airlines, prioritizing daytime departures and layovers under two hours, then summarize the three best choices",
        status: "running",
        detail:
          "Currently comparing baggage policies, seat pitch, and loyalty program transfer bonuses across Star Alliance and Oneworld carriers",
      }),
    ],
  },
};

export const NarrowMobile: Story = {
  args: {
    tasks: [
      task({ id: "t1", goal: "Book a flight to Tokyo with a very long destination description", status: "running", detail: "Comparing 3 airlines with detailed fare rules" }),
      task({ id: "t2", goal: "Reserve a hotel near Shibuya", status: "pending" }),
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 390 }}>
        <Story />
      </div>
    ),
  ],
};
