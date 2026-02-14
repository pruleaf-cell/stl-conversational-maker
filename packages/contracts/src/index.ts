export type SessionStatus =
  | "collecting"
  | "questions_ready"
  | "ready_to_build"
  | "building"
  | "completed"
  | "failed";

export type InputType = "select" | "number" | "text";

export interface CreateSessionRequest {
  prompt: string;
}

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

export type Shape =
  | "heart"
  | "circle"
  | "star"
  | "rounded_square"
  | "custom_outline";

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

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  summary: string;
  questions: ClarificationQuestion[];
  modelSpec: ModelSpec | null;
  adjustments: AutoAdjustment[];
}

export interface BuildRequest {
  sessionId: string;
  printerProfile: PrinterProfile;
}

export type BuildStatus = "queued" | "running" | "completed" | "failed";

export interface BuildResult {
  jobId: string;
  status: BuildStatus;
  stlUrl?: string;
  project3mfUrl?: string;
  reportUrl?: string;
}

export const STAGE_LABELS = [
  "Understanding request",
  "Preparing geometry",
  "Validating printability",
  "Slicing for printer profile",
  "Packaging files"
] as const;
