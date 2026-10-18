import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentTask } from "../../../hooks/useAgentTasks";
import { TaskNestPanel } from "./TaskNestPanel";

const meta: Meta<typeof TaskNestPanel> = {
  title: "Components/TaskNestPanel",
  component: TaskNestPanel,
  args: {
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

export const LongCjkNarrowMobile: Story = {
  args: {
    tasks: [
      task({
        id: "topic-long-cjk",
        goal: "上海周末亲子出行与室内活动安排以及儿童展览预约清单",
        topicPhrase: "上海周末亲子出行与室内活动安排以及儿童展览预约清单",
        topicSummary: "正在比较交通、天气、展览预约和适合儿童的室内活动，并整理成一份可执行的周末计划",
        status: "pending",
      }),
      task({
        id: "topic-follow-up",
        goal: "餐厅预订",
        topicPhrase: "餐厅预订",
        topicSummary: "等待确认用餐时间和人数",
        status: "completed",
      }),
      task({
        id: "topic-third",
        goal: "路线备选",
        topicPhrase: "路线备选",
        topicSummary: "整理地铁和打车两种方案",
        status: "completed",
      }),
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

export const ScribeLedger: Story = {
  args: {
    tasks: [
      task({
        id: "topic-feishu",
        goal: "飞书",
        topicPhrase: "飞书",
        topicSummary: "用户正在了解企业协作功能",
        status: "pending",
      }),
      task({
        id: "topic-weather",
        goal: "天气查询",
        topicPhrase: "天气查询",
        topicSummary: "上海与北京的天气和空气质量",
        status: "completed",
      }),
      task({
        id: "topic-air",
        goal: "空气质量",
        topicPhrase: "空气质量",
        topicSummary: "比较两地今天和明天的空气质量",
        status: "completed",
      }),
    ],
  },
};
