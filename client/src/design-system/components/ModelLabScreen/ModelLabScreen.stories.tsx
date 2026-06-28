import type { ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ModelLabFieldValue, ModelLabSchema, ModelLabValues } from "../../../hooks/useTranslatorConnection.types";
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
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ModelLabScreen>;

// NOTE: by default these stories fetch from a real server address and will
// show the "couldn't reach the server" state in isolated Storybook (no
// backend running) -- same posture as the old ModelLabScreen/
// ModelProviderScreen stories. The variants below stub `window.fetch` via a
// decorator (no mocking library wired into this project yet) so the
// dynamic-schema rendering, multi-adapter switching, and populated
// test-result states are visible without a live backend.

const cloudOnlySchema: ModelLabSchema = {
  text: {
    adapters: [
      {
        id: "cloud:text",
        label: "Cloud",
        capability: "text",
        fields: [
          {
            key: "system_prompt_override",
            label: "Persona / system prompt",
            kind: "textarea",
            help: "Replaces the assistant's persona and behavior instructions.",
          },
          { key: "temperature", label: "Temperature", kind: "number", min: 0, max: 1, step: 0.05 },
          { key: "top_p", label: "Top-p", kind: "number", min: 0, max: 1, step: 0.05 },
          { key: "max_tokens", label: "Max tokens", kind: "number", min: 1, max: 4096 },
        ],
      },
    ],
  },
  speech: {
    adapters: [
      {
        id: "cloud:speech",
        label: "Cloud",
        capability: "speech",
        fields: [{ key: "voice", label: "Voice ID", kind: "text" }],
      },
    ],
  },
  transcription: {
    adapters: [
      {
        id: "cloud:transcription",
        label: "Cloud",
        capability: "transcription",
        fields: [{ key: "language_hint", label: "Language hint", kind: "text" }],
      },
    ],
  },
};

const cloudAndLocalSchema: ModelLabSchema = {
  ...cloudOnlySchema,
  text: {
    adapters: [
      ...cloudOnlySchema.text.adapters,
      {
        id: "omlx:qwen3_5",
        label: "Local (Qwen3.5)",
        capability: "text",
        fields: [
          { key: "temperature", label: "Temperature", kind: "number", min: 0, max: 1, step: 0.05 },
          { key: "top_p", label: "Top-p", kind: "number", min: 0, max: 1, step: 0.05 },
          {
            key: "enable_thinking",
            label: "Enable thinking",
            kind: "boolean",
            help: "Slower, possibly higher quality.",
          },
        ],
      },
    ],
  },
};

const emptyValues: ModelLabValues = {};

const populatedValues: ModelLabValues = {
  "cloud:text": { temperature: 0.7, top_p: 0.9, max_tokens: 512 },
};

/** Stubs `window.fetch` for the duration of a story so the component can run
 * its real hook logic against canned responses, without a live backend. */
function withFetchStub(schema: ModelLabSchema, values: ModelLabValues, previewOutput?: string) {
  return (Story: () => ReactElement) => {
    const originalFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/model-lab/schema")) {
        return new Response(JSON.stringify(schema), { status: 200 });
      }
      if (url.endsWith("/api/model-lab/values") && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(values), { status: 200 });
      }
      if (url.endsWith("/api/model-lab/values") && init?.method === "PUT") {
        const body: Record<string, Record<string, ModelLabFieldValue>> = JSON.parse(String(init.body));
        const merged = { ...values };
        for (const [adapterId, fields] of Object.entries(body)) {
          merged[adapterId] = { ...(merged[adapterId] ?? {}), ...fields };
        }
        return new Response(JSON.stringify(merged), { status: 200 });
      }
      if (url.endsWith("/api/model-lab/preview/text")) {
        return new Response(JSON.stringify({ output_text: previewOutput ?? "(no preview configured)" }), {
          status: 200,
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    return <Story />;
  };
}

export const Default: Story = {};

export const CloudOnly: Story = {
  decorators: [withFetchStub(cloudOnlySchema, emptyValues)],
};

export const CloudAndLocalAdapters: Story = {
  decorators: [withFetchStub(cloudAndLocalSchema, emptyValues)],
};

export const PopulatedWithTestResult: Story = {
  decorators: [
    withFetchStub(
      cloudOnlySchema,
      populatedValues,
      "Bonjour ! Comment puis-je vous aider aujourd'hui ?"
    ),
  ],
};
