import { NextResponse } from "next/server";
import type { InterpretRequest } from "@stl-maker/contracts";
import { orchestrateInterpretation } from "../../../../lib/server/orchestration/agents";

export const runtime = "nodejs";

function badRequest(message: string): NextResponse {
  return new NextResponse(message, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: InterpretRequest;

  try {
    payload = (await request.json()) as InterpretRequest;
  } catch {
    return badRequest("Invalid JSON body.");
  }

  if (!payload || typeof payload.prompt !== "string") {
    return badRequest("Field 'prompt' is required.");
  }

  const prompt = payload.prompt.trim();
  if (!prompt || prompt.length > 2000) {
    return badRequest("Prompt must be between 1 and 2000 characters.");
  }

  try {
    const result = await orchestrateInterpretation({
      prompt,
      answers: payload.answers,
      draftSpec: payload.draftSpec
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to interpret request.";
    return new NextResponse(message, { status: 500 });
  }
}
