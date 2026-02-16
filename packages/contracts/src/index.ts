export type InputType = "select" | "number" | "text";

export interface ClarificationQuestion {
  id: string;
  label: string;
  inputType: InputType;
  required: boolean;
  options?: string[];
  unit?: "mm";
}

export type ObjectClass =
  | "earring"
  | "pendant"
  | "ring"
  | "fidget_token"
  | "fidget_spinner";

export type Shape = "heart" | "circle" | "star" | "rounded_square" | "custom_outline";

export type PrinterProfile = "A1_PLA_0.4" | "P1_PLA_0.4" | "X1_PLA_0.4";

export interface ModelSpec {
  objectClass: ObjectClass;
  shape: Shape;
  dimensionsMm: Record<string, number>;
  featureFlags: Record<string, boolean>;
  printerProfile: PrinterProfile;
}

export interface AutoAdjustment {
  field: string;
  from: number | string;
  to: number | string;
  reason: string;
}

export interface InterpretRequest {
  prompt: string;
  answers?: Record<string, string | number>;
  draftSpec?: ModelSpec;
}

export interface InterpretResponse {
  summary: string;
  questions: ClarificationQuestion[];
  modelSpec: ModelSpec;
  adjustments: AutoAdjustment[];
}

export interface GenerateRequest {
  modelSpec: ModelSpec;
  printerProfile: PrinterProfile;
}

export interface GenerateResponse {
  stlFileName: string;
  stlBase64: string;
  slicingGuide: {
    profile: string;
    notes: string[];
    recommendedSteps: string[];
  };
}

export const STAGE_LABELS = [
  "Understanding request",
  "Preparing geometry",
  "Validating printability",
  "Generating STL",
  "Preparing slicing guide"
] as const;
