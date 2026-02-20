// Reflective Memory — Model Gateway
// Stateless adapter for AI model API calls.
// No reference to Memory Service. No write path back to any store.
// Prompt in, text out. Nothing else.

// =============================================================================
// Types
// =============================================================================

/**
 * Full configuration for making a model API call. Includes secrets.
 * This is server-side config — never sent to the client.
 */
export interface ModelGatewayConfig {
  /** Only "openai" is supported. Covers any OpenAI-compatible API. */
  provider: "openai";

  /** Model identifier, e.g. "gpt-4o", "gpt-4o-mini". */
  model: string;

  /** API key for the model provider. Never included in receipts. */
  apiKey: string;

  /**
   * Base URL for the API. Required, no default.
   * OpenAI: "https://api.openai.com/v1"
   * Local (ollama, llama.cpp): "http://localhost:11434/v1"
   */
  baseUrl: string;

  /** Model parameters. All required, no defaults. */
  parameters: {
    temperature: number;
    maxTokens: number;
  };
}

/**
 * Safe subset of model config for inclusion in a QueryReceipt.
 * No secrets. No URLs. Just what the user needs to know about
 * how the model was configured for their query.
 */
export interface ModelConfigReceipt {
  provider: string;
  model: string;
  parameters: Record<string, unknown>;
}

// =============================================================================
// getConfigReceipt
// =============================================================================
// Extracts the non-secret fields from a ModelGatewayConfig.
// Used by the query route to build the QueryReceipt.
//
// Deliberately omits:
// - apiKey (secret)
// - baseUrl (infrastructure detail, potential information leak)
// =============================================================================

export function getConfigReceipt(config: ModelGatewayConfig): ModelConfigReceipt {
  return {
    provider: config.provider,
    model: config.model,
    parameters: {
      temperature: config.parameters.temperature,
      max_tokens: config.parameters.maxTokens,
    },
  };
}

// =============================================================================
// callModel
// =============================================================================
// Sends an assembled prompt to the configured model API and returns the
// response text.
//
// Guarantees (Invariant 4 — No AI Write Path):
// - This module does not import, reference, or know about the Memory Service.
// - The return value is a plain string. Not a structured object, not a
//   tool-call response, not a command. A string.
// - The caller (route handler) does not feed this string back into any
//   write operation. The data flow is one-directional.
//
// Error handling:
// - Network errors throw with a descriptive message.
// - Non-2xx HTTP responses throw with the status code.
// - Unexpected response shapes throw.
// - No retries. No fallback. The error propagates to the caller.
// =============================================================================

export async function callModel(
  config: ModelGatewayConfig,
  prompt: string,
): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  // --- Make the HTTP request ---
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: config.parameters.temperature,
        max_tokens: config.parameters.maxTokens,
      }),
    });
  } catch (error) {
    throw new Error(
      `Model API request failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  // --- Check HTTP status ---
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Model API returned HTTP ${response.status}: ${body}`);
  }

  // --- Parse response ---
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Model API returned invalid JSON");
  }

  // --- Extract content ---
  // Validate the response shape defensively. No assumptions about the
  // upstream API's behavior.
  const content = (
    data as {
      choices?: Array<{ message?: { content?: string | null } }>;
    }
  )?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error("Model API returned no content in response");
  }

  return content;
}
