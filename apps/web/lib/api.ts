import type {
  BuildRequest,
  BuildResult,
  CreateSessionRequest,
  SessionState
} from "@stl-maker/contracts";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

export interface BuildStatusResponse extends BuildResult {
  stage?: string;
  error?: string;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function createSession(
  payload: CreateSessionRequest
): Promise<SessionState> {
  const response = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse<SessionState>(response);
}

export async function submitAnswers(
  sessionId: string,
  answers: Record<string, string | number>
): Promise<SessionState> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/answers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers })
  });
  return parseResponse<SessionState>(response);
}

export async function patchSpec(
  sessionId: string,
  dimensionsMm: Record<string, number>
): Promise<SessionState> {
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/spec`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dimensionsMm })
  });
  return parseResponse<SessionState>(response);
}

export async function createBuild(payload: BuildRequest): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/builds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse<BuildResult>(response);
}

export async function getBuild(jobId: string): Promise<BuildStatusResponse> {
  const response = await fetch(`${API_BASE}/builds/${jobId}`);
  return parseResponse<BuildStatusResponse>(response);
}

export async function getArtifacts(jobId: string): Promise<BuildStatusResponse> {
  const response = await fetch(`${API_BASE}/builds/${jobId}/artifacts`);
  return parseResponse<BuildStatusResponse>(response);
}
