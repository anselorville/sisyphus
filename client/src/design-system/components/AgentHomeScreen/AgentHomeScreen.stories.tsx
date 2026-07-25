import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentTask } from "../../../hooks/useAgentTasks";
import { AgentHomeScreen } from "./AgentHomeScreen";

function task(overrides: Partial<AgentTask> & Pick<AgentTask, "id" | "goal" | "status">): AgentTask {
  return { updatedAt: Date.now(), ...overrides };
}

const meta: Meta<typeof AgentHomeScreen> = {
  title: "Screens/AgentHomeScreen",
  component: AgentHomeScreen,
  parameters: { layout: "fullscreen" },
  args: {
    connectionState: "connected",
    micLevel: 0,
    onConnect: () => {},
    onDisconnect: () => {},
    manualTurnMode: true,
    micOpen: false,
    onToggleMic: () => {},
    statusDetail: undefined,
    tasks: [],
    onCancelTask: () => {},
    onSteerTask: () => {},
    onFollowUpTask: () => {},
    ecology: "prosperous",
    food: "prosperous",
    sidecarConnected: true,
    elevationRequest: null,
    onElevationAllow: () => {},
    onElevationDeny: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ height: "700px" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AgentHomeScreen>;

export const Idle: Story = {
  args: { activity: "idle" },
};

export const Listening: Story = {
  args: { activity: "listening", micOpen: true, statusDetail: "Turn open" },
};

export const Speaking: Story = {
  args: { activity: "speaking", statusDetail: "Reading back your itinerary" },
};

export const Working: Story = {
  args: {
    activity: "working",
    statusDetail: "2 tasks running",
    tasks: [
      task({ id: "t1", goal: "Book a flight to Tokyo", status: "running", detail: "Comparing 3 airlines" }),
      task({ id: "t2", goal: "Reserve a hotel near Shibuya", status: "running", detail: "Checking availability" }),
    ],
  },
};

export const Hibernating: Story = {
  args: {
    activity: "hibernating",
    ecology: "hibernating",
    food: "hibernating",
    statusDetail: "Usage exhausted",
  },
};

export const MultipleTasksRunningAndQueued: Story = {
  args: {
    activity: "working",
    statusDetail: "4 tasks",
    tasks: [
      task({ id: "t1", goal: "Book a flight to Tokyo", status: "running", detail: "Comparing 3 airlines" }),
      task({ id: "t2", goal: "Reserve a hotel near Shibuya", status: "assigned" }),
      task({ id: "t3", goal: "Draft a packing list", status: "pending" }),
      task({ id: "t4", goal: "Check the weather forecast", status: "pending" }),
      task({ id: "t5", goal: "Confirm airport transfer", status: "completed", detail: "Booked a taxi for 7am" }),
    ],
  },
};

export const ProsperousEcology: Story = {
  args: { activity: "idle", ecology: "prosperous", food: "prosperous" },
};

export const ConservingEcology: Story = {
  args: { activity: "working", ecology: "conserving", food: "conserving", statusDetail: "1 task running" },
};

export const ReserveEcology: Story = {
  args: { activity: "working", ecology: "reserve", food: "reserve", statusDetail: "Prioritizing important tasks" },
};

export const HibernatingEcology: Story = {
  args: { activity: "hibernating", ecology: "hibernating", food: "hibernating" },
};

export const ElevationRequestOpen: Story = {
  args: {
    activity: "working",
    tasks: [task({ id: "t1", goal: "Book a flight to Tokyo", status: "blocked", detail: "Waiting for approval" })],
    elevationRequest: {
      requestId: "req-1",
      action: "book a $450 flight to Tokyo",
      impact: "your linked payment method",
      taskId: "t1",
    },
  },
};

export const LongTextContent: Story = {
  args: {
    activity: "working",
    statusDetail: "Coordinating 4 background tasks across 3 roles while researching options",
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
    activity: "working",
    statusDetail: "Coordinating 4 background tasks across 3 roles",
    tasks: [
      task({ id: "t1", goal: "Book a flight to Tokyo with extra baggage", status: "running", detail: "Comparing 3 airlines" }),
      task({ id: "t2", goal: "Reserve a hotel near Shibuya", status: "pending" }),
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844 }}>
        <Story />
      </div>
    ),
  ],
};
