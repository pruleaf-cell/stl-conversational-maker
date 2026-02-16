import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import type { GenerateRequest, ModelSpec, PrinterProfile } from "@stl-maker/contracts";
import { buildSlicingGuide, generateStl } from "../../../../lib/server/geometry/generator";
import { applyPrintabilityConstraints } from "../../../../lib/server/orchestration/constraints";

export const runtime = "nodejs";

const PROFILES: PrinterProfile[] = ["A1_PLA_0.4", "P1_PLA_0.4", "X1_PLA_0.4"];

function badRequest(message: string): NextResponse {
  return new NextResponse(message, { status: 400 });
}

function isPrinterProfile(value: string): value is PrinterProfile {
  return PROFILES.includes(value as PrinterProfile);
}

function isModelSpec(candidate: unknown): candidate is ModelSpec {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }

  const spec = candidate as Partial<ModelSpec>;
  return (
    typeof spec.objectClass === "string" &&
    typeof spec.shape === "string" &&
    !!spec.dimensionsMm &&
    typeof spec.dimensionsMm === "object" &&
    !!spec.featureFlags &&
    typeof spec.featureFlags === "object" &&
    typeof spec.printerProfile === "string"
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: GenerateRequest;

  try {
    payload = (await request.json()) as GenerateRequest;
  } catch {
    return badRequest("Invalid JSON body.");
  }

  if (!payload || !isModelSpec(payload.modelSpec)) {
    return badRequest("Field 'modelSpec' is required.");
  }

  if (!payload.printerProfile || !isPrinterProfile(payload.printerProfile)) {
    return badRequest("Field 'printerProfile' must be a supported PLA profile.");
  }

  try {
    const constrained = applyPrintabilityConstraints({
      ...payload.modelSpec,
      printerProfile: payload.printerProfile
    });

    const generated = generateStl(constrained.spec);
    const slicingGuide = buildSlicingGuide(payload.printerProfile);

    return NextResponse.json({
      stlFileName: generated.fileName,
      stlBase64: Buffer.from(generated.stlAscii, "utf-8").toString("base64"),
      slicingGuide
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate STL.";
    return new NextResponse(message, { status: 500 });
  }
}
