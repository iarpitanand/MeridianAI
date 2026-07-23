import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}

export const llmEnabled = (): boolean => Boolean(config.ANTHROPIC_API_KEY);

/**
 * Call a model that must respond via a single forced tool, and return the
 * tool input as typed JSON. Throws if the model doesn't use the tool.
 */
export async function callTool<T>(params: {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  const res = await anthropic().messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
    tools: [
      {
        name: params.toolName,
        description: params.toolDescription,
        input_schema: params.schema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: params.toolName },
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("model did not return a tool_use block");
  }
  return block.input as T;
}
