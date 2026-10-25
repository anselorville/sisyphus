/** The Device Steward's tools as Pi custom tools (LLM-callable surface over DeviceTools). */

import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { DeviceTools } from "./device-tools.js";

const ServiceActionParams = Type.Object({
  service: Type.String({ description: "marcus-backend, marcus-frontend or marcus-sidecar" }),
  action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart"), Type.Literal("shutdown")]),
});

function text(value: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: value }], details: undefined };
}

export function createDeviceToolDefinitions(device: DeviceTools): ToolDefinition[] {
  return [
    {
      name: "device_status",
      label: "Device Status",
      description: "Report whether Marcus's own services (sidecar, backend, frontend) are running.",
      promptSnippet: "device_status() -- are my services up?",
      promptGuidelines: ["Reading status is always safe; say plainly what is running and what is not"],
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult<unknown>> {
        const snapshot = await device.device_status();
        return text(snapshot.services.map((s) => `${s.name}: ${s.state}${s.detail ? ` (${s.detail})` : ""}`).join("\n"));
      },
    },
    {
      name: "service_action",
      label: "Service Action",
      description:
        "Act on one of Marcus's services. Only restarting marcus-backend is supported; it drops the current voice connection, so tell the user first.",
      promptSnippet: "service_action(service, action) -- restart marcus-backend",
      promptGuidelines: ["Say what you are about to do and that the call will drop, then act", "Anything other than restarting marcus-backend is unsupported"],
      parameters: ServiceActionParams,
      async execute(_id, params): Promise<AgentToolResult<unknown>> {
        const p = params as Static<typeof ServiceActionParams>;
        const result = await device.service_action({ service: p.service, action: p.action });
        return text(`${result.success ? "OK" : "NOT DONE"}: ${p.action} ${p.service}${result.detail ? ` -- ${result.detail}` : ""}`);
      },
    },
  ];
}
