import type {
  GenerateRequest,
  GenerateResponse,
  InterpretRequest,
  InterpretResponse
} from "@stl-maker/contracts";

const API_BASE = "/api/v1";

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function interpret(payload: InterpretRequest): Promise<InterpretResponse> {
  const response = await fetch(`${API_BASE}/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse<InterpretResponse>(response);
}

export async function generate(payload: GenerateRequest): Promise<GenerateResponse> {
  const response = await fetch(`${API_BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse<GenerateResponse>(response);
}
