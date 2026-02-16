import OpenAI from "openai";
import type {
  AutoAdjustment,
  ClarificationQuestion,
  InterpretResponse,
  ModelSpec,
  ObjectClass,
  PrinterProfile,
  Shape
} from "@stl-maker/contracts";
import { applyPrintabilityConstraints } from "./constraints";

const OBJECT_CLASSES: ObjectClass[] = [
  "earring",
  "pendant",
  "ring",
  "fidget_token",
  "fidget_spinner"
];

const SHAPES: Shape[] = ["heart", "circle", "star", "rounded_square", "custom_outline"];

const PRINTER_PROFILES: PrinterProfile[] = ["A1_PLA_0.4", "P1_PLA_0.4", "X1_PLA_0.4"];

const DEFAULT_DIMENSIONS: Record<ObjectClass, Record<string, number>> = {
  earring: { width: 20, height: 20, thickness: 2, hole_diameter: 2 },
  pendant: { width: 30, height: 30, thickness: 2.4, hole_diameter: 2.2 },
  ring: { outer_diameter: 22, band_width: 4, thickness: 2 },
  fidget_token: { width: 35, height: 35, thickness: 3 },
  fidget_spinner: { width: 65, height: 65, thickness: 5, hole_diameter: 22 }
};

const OBJECT_KEYWORDS: Array<[string, ObjectClass]> = [
  ["fidget spinner", "fidget_spinner"],
  ["spinner", "fidget_spinner"],
  ["fidget token", "fidget_token"],
  ["token", "fidget_token"],
  ["earring", "earring"],
  ["pendant", "pendant"],
  ["ring", "ring"]
];

const SHAPE_KEYWORDS: Array<[string, Shape]> = [
  ["heart", "heart"],
  ["circle", "circle"],
  ["round", "circle"],
  ["star", "star"],
  ["rounded square", "rounded_square"],
  ["square", "rounded_square"]
];

const DIMENSION_PATTERN =
  /(?<value>\d+(?:\.\d+)?)\s*(?<unit>mm|millimetres?|millimeters?|cm|inches?|inch|in)\b/gi;

const SPECIALIST_MODEL = process.env.OPENAI_SPECIALIST_MODEL ?? "gpt-5-mini";
const MERGE_MODEL = process.env.OPENAI_MERGE_MODEL ?? "gpt-5";

interface PromptSeed {
  objectClass: ObjectClass;
  objectExplicit: boolean;
  shape: Shape;
  shapeExplicit: boolean;
  dimensions: Record<string, number>;
  dimensionFieldsExplicit: Set<string>;
}

interface IntentResult {
  objectClass: ObjectClass;
  shape: Shape;
  confidence: number;
}

interface GeometryResult {
  dimensionsMm: Record<string, number>;
  featureFlags: Record<string, boolean>;
  shape: Shape;
}

interface ManufacturabilityResult {
  minimums: Record<string, number>;
  notes: string[];
}

interface QuestionResult {
  questions: ClarificationQuestion[];
}

interface SlicingResult {
  printerProfile: PrinterProfile;
  material: string;
}

interface SafetyResult {
  warnings: string[];
  confidence: number;
}

interface OrchestrationInput {
  prompt: string;
  answers?: Record<string, string | number>;
  draftSpec?: ModelSpec;
}

let cachedClient: OpenAI | null | undefined;

function getOpenAIClient(): OpenAI | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  if (!process.env.OPENAI_API_KEY) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return cachedClient;
}

function isObjectClass(value: string): value is ObjectClass {
  return OBJECT_CLASSES.includes(value as ObjectClass);
}

function isShape(value: string): value is Shape {
  return SHAPES.includes(value as Shape);
}

function isPrinterProfile(value: string): value is PrinterProfile {
  return PRINTER_PROFILES.includes(value as PrinterProfile);
}

function normaliseLength(value: number, unit: string): number {
  const lowered = unit.toLowerCase();
  if (lowered.startsWith("cm")) {
    return value * 10;
  }
  if (lowered.startsWith("in")) {
    return value * 25.4;
  }
  return value;
}

function pickKeyword<T extends string>(
  promptLower: string,
  mapping: Array<[string, T]>,
  fallback: T
): { value: T; explicit: boolean } {
  for (const [key, value] of mapping) {
    if (promptLower.includes(key)) {
      return { value, explicit: true };
    }
  }
  return { value: fallback, explicit: false };
}

function captureDimensions(prompt: string): {
  dimensions: Record<string, number>;
  explicitFields: Set<string>;
} {
  const lower = prompt.toLowerCase();
  const dimensions: Record<string, number> = {};
  const explicitFields = new Set<string>();

  for (const match of prompt.matchAll(DIMENSION_PATTERN)) {
    const rawValue = Number(match.groups?.value);
    const unit = match.groups?.unit;
    if (!Number.isFinite(rawValue) || !unit) {
      continue;
    }

    const converted = Number(normaliseLength(rawValue, unit).toFixed(3));
    const start = Math.max(0, (match.index ?? 0) - 24);
    const end = Math.min(lower.length, (match.index ?? 0) + match[0].length + 24);
    const window = lower.slice(start, end);

    let field: string | null = null;
    if (["deep", "thick", "thickness", "depth"].some((token) => window.includes(token))) {
      field = "thickness";
    } else if (window.includes("hole") && window.includes("diam")) {
      field = "hole_diameter";
    } else if (window.includes("hole")) {
      field = "hole_diameter";
    } else if (window.includes("outer") && window.includes("diam")) {
      field = "outer_diameter";
    } else if (window.includes("diam")) {
      field = dimensions.width === undefined ? "width" : "height";
    } else if (window.includes("width")) {
      field = "width";
    } else if (window.includes("height")) {
      field = "height";
    }

    if (!field) {
      if (dimensions.thickness === undefined) {
        field = "thickness";
      } else if (dimensions.width === undefined) {
        field = "width";
      } else if (dimensions.height === undefined) {
        field = "height";
      } else {
        field = "feature_size";
      }
    }

    dimensions[field] = converted;
    explicitFields.add(field);
  }

  return { dimensions, explicitFields };
}

function parsePrompt(prompt: string): PromptSeed {
  const lower = prompt.toLowerCase();
  const object = pickKeyword(lower, OBJECT_KEYWORDS, "pendant");
  const shape = pickKeyword(lower, SHAPE_KEYWORDS, "circle");
  const parsedDimensions = captureDimensions(prompt);

  return {
    objectClass: object.value,
    objectExplicit: object.explicit,
    shape: shape.value,
    shapeExplicit: shape.explicit,
    dimensions: parsedDimensions.dimensions,
    dimensionFieldsExplicit: parsedDimensions.explicitFields
  };
}

function parseJSONObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

async function callSpecialistLLM(
  agentName: string,
  prompt: string,
  seed: PromptSeed,
  expectedSchema: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const client = getOpenAIClient();
  if (!client) {
    return null;
  }

  const system =
    `You are ${agentName} for a 3D-print assistant. ` +
    "Return strict JSON only and use British English for all wording.";

  try {
    const completion = await client.chat.completions.create({
      model: SPECIALIST_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            prompt,
            seed,
            expectedSchema
          })
        }
      ]
    });

    return parseJSONObject(completion.choices[0]?.message?.content);
  } catch {
    return null;
  }
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function sanitiseDimensions(input: Record<string, unknown>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    const numeric = asFiniteNumber(value);
    if (numeric === null) {
      continue;
    }
    output[key] = Number(Math.max(0.1, numeric).toFixed(3));
  }
  return output;
}

function normaliseSpec(draftSpec: ModelSpec | undefined, fallback: ModelSpec): ModelSpec {
  if (!draftSpec) {
    return fallback;
  }

  const objectClass = isObjectClass(draftSpec.objectClass) ? draftSpec.objectClass : fallback.objectClass;
  const shape = isShape(draftSpec.shape) ? draftSpec.shape : fallback.shape;
  const printerProfile = isPrinterProfile(draftSpec.printerProfile)
    ? draftSpec.printerProfile
    : fallback.printerProfile;

  return {
    objectClass,
    shape,
    dimensionsMm: {
      ...DEFAULT_DIMENSIONS[objectClass],
      ...sanitiseDimensions(draftSpec.dimensionsMm)
    },
    featureFlags:
      draftSpec.featureFlags && typeof draftSpec.featureFlags === "object"
        ? { ...draftSpec.featureFlags }
        : { ...fallback.featureFlags },
    printerProfile
  };
}

function sanitiseQuestion(item: unknown): ClarificationQuestion | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const candidate = item as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const inputType =
    candidate.inputType === "select" || candidate.inputType === "number" || candidate.inputType === "text"
      ? candidate.inputType
      : null;

  if (!id || !label || !inputType) {
    return null;
  }

  const options =
    Array.isArray(candidate.options) && candidate.options.every((value) => typeof value === "string")
      ? (candidate.options as string[])
      : undefined;

  return {
    id,
    label,
    inputType,
    required: candidate.required === false ? false : true,
    options,
    unit: candidate.unit === "mm" ? "mm" : undefined
  };
}

async function intentAgent(prompt: string, seed: PromptSeed): Promise<IntentResult> {
  const result: IntentResult = {
    objectClass: seed.objectClass,
    shape: seed.shape,
    confidence: seed.objectExplicit ? 0.84 : 0.58
  };

  const llm = await callSpecialistLLM("IntentAgent", prompt, seed, {
    objectClass: "earring|pendant|ring|fidget_token|fidget_spinner",
    shape: "heart|circle|star|rounded_square|custom_outline",
    confidence: "0-1"
  });

  if (llm) {
    if (typeof llm.objectClass === "string" && isObjectClass(llm.objectClass)) {
      result.objectClass = llm.objectClass;
    }
    if (typeof llm.shape === "string" && isShape(llm.shape)) {
      result.shape = llm.shape;
    }
    const confidence = asFiniteNumber(llm.confidence);
    if (confidence !== null) {
      result.confidence = Math.max(0, Math.min(1, confidence));
    }
  }

  return result;
}

async function geometryAgent(prompt: string, seed: PromptSeed): Promise<GeometryResult> {
  const dimensions = {
    ...DEFAULT_DIMENSIONS[seed.objectClass],
    ...seed.dimensions
  };

  const result: GeometryResult = {
    dimensionsMm: dimensions,
    featureFlags: {
      mirror: false,
      add_loop: seed.objectClass === "earring" || seed.objectClass === "pendant",
      rounded_edges: true
    },
    shape: seed.shape
  };

  const llm = await callSpecialistLLM("GeometryAgent", prompt, seed, {
    dimensionsMm: { thickness: 2, width: 20, height: 20 },
    featureFlags: { rounded_edges: true },
    shape: "heart|circle|star|rounded_square|custom_outline"
  });

  if (llm) {
    if (llm.dimensionsMm && typeof llm.dimensionsMm === "object" && !Array.isArray(llm.dimensionsMm)) {
      result.dimensionsMm = {
        ...result.dimensionsMm,
        ...sanitiseDimensions(llm.dimensionsMm as Record<string, unknown>)
      };
    }

    if (llm.featureFlags && typeof llm.featureFlags === "object" && !Array.isArray(llm.featureFlags)) {
      const mergedFlags: Record<string, boolean> = { ...result.featureFlags };
      for (const [key, value] of Object.entries(llm.featureFlags as Record<string, unknown>)) {
        if (typeof value === "boolean") {
          mergedFlags[key] = value;
        }
      }
      result.featureFlags = mergedFlags;
    }

    if (typeof llm.shape === "string" && isShape(llm.shape)) {
      result.shape = llm.shape;
    }
  }

  return result;
}

async function manufacturabilityAgent(
  prompt: string,
  seed: PromptSeed
): Promise<ManufacturabilityResult> {
  const result: ManufacturabilityResult = {
    minimums: {
      thickness: 1.2,
      emboss_depth: 0.6,
      deboss_depth: 0.6,
      hole_diameter: 1.6
    },
    notes: [
      "Apply PLA-safe minimums for thin features.",
      "Avoid brittle details for small jewellery prints."
    ]
  };

  const llm = await callSpecialistLLM("ManufacturabilityAgent", prompt, seed, {
    minimums: { thickness: 1.2, hole_diameter: 1.6 },
    notes: ["string"]
  });

  if (llm) {
    if (llm.minimums && typeof llm.minimums === "object" && !Array.isArray(llm.minimums)) {
      for (const [key, value] of Object.entries(llm.minimums as Record<string, unknown>)) {
        const numeric = asFiniteNumber(value);
        if (numeric !== null) {
          result.minimums[key] = Number(Math.max(0.1, numeric).toFixed(3));
        }
      }
    }

    if (Array.isArray(llm.notes)) {
      result.notes = llm.notes
        .map((item) => (typeof item === "string" ? item : ""))
        .filter(Boolean)
        .slice(0, 4);
    }
  }

  return result;
}

function buildDefaultQuestions(seed: PromptSeed): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  if (!seed.objectExplicit) {
    questions.push({
      id: "object_class",
      label: "What kind of item are you making?",
      inputType: "select",
      required: true,
      options: [...OBJECT_CLASSES]
    });
  }

  if (!seed.shapeExplicit) {
    questions.push({
      id: "shape",
      label: "Which shape should we use?",
      inputType: "select",
      required: true,
      options: ["heart", "circle", "star", "rounded_square"]
    });
  }

  for (const [field, label] of [
    ["width", "What width should it be?"],
    ["height", "What height should it be?"],
    ["thickness", "What thickness should it be?"]
  ]) {
    if (!seed.dimensionFieldsExplicit.has(field)) {
      questions.push({
        id: field,
        label,
        inputType: "number",
        required: true,
        unit: "mm"
      });
    }
  }

  if (["earring", "pendant", "fidget_spinner"].includes(seed.objectClass)) {
    if (!seed.dimensionFieldsExplicit.has("hole_diameter")) {
      questions.push({
        id: "hole_diameter",
        label: "What hole diameter would you like?",
        inputType: "number",
        required: true,
        unit: "mm"
      });
    }
  }

  return questions.slice(0, 4);
}

async function questionAgent(prompt: string, seed: PromptSeed): Promise<QuestionResult> {
  const result: QuestionResult = {
    questions: buildDefaultQuestions(seed)
  };

  const llm = await callSpecialistLLM("QuestionAgent", prompt, seed, {
    questions: [
      {
        id: "thickness",
        label: "string",
        inputType: "number",
        required: true,
        unit: "mm"
      }
    ]
  });

  if (!llm || !Array.isArray(llm.questions)) {
    return result;
  }

  const parsed = llm.questions.map((item) => sanitiseQuestion(item)).filter((item): item is ClarificationQuestion => !!item);
  if (parsed.length > 0) {
    result.questions = parsed.slice(0, 4);
  }

  return result;
}

async function slicingAgent(prompt: string, seed: PromptSeed): Promise<SlicingResult> {
  const result: SlicingResult = {
    printerProfile: seed.objectClass === "fidget_spinner" ? "P1_PLA_0.4" : "A1_PLA_0.4",
    material: "PLA"
  };

  const llm = await callSpecialistLLM("SlicingAgent", prompt, seed, {
    printerProfile: "A1_PLA_0.4|P1_PLA_0.4|X1_PLA_0.4",
    material: "PLA"
  });

  if (llm) {
    if (typeof llm.printerProfile === "string" && isPrinterProfile(llm.printerProfile)) {
      result.printerProfile = llm.printerProfile;
    }
    if (typeof llm.material === "string" && llm.material.trim()) {
      result.material = llm.material.trim();
    }
  }

  return result;
}

async function safetyAgent(prompt: string, seed: PromptSeed): Promise<SafetyResult> {
  const warnings: string[] = [];
  let confidence = 0.92;

  if (seed.dimensions.thickness !== undefined && seed.dimensions.thickness < 1.2) {
    warnings.push("Requested thickness is below the safe PLA minimum.");
    confidence -= 0.22;
  }

  if (prompt.toLowerCase().includes("knife") || prompt.toLowerCase().includes("weapon")) {
    warnings.push("Potentially unsafe request detected.");
    confidence = Math.min(confidence, 0.25);
  }

  const result: SafetyResult = {
    warnings,
    confidence: Math.max(0.1, confidence)
  };

  const llm = await callSpecialistLLM("SafetyAgent", prompt, seed, {
    warnings: ["string"],
    confidence: "0-1"
  });

  if (llm) {
    if (Array.isArray(llm.warnings)) {
      result.warnings = llm.warnings
        .map((item) => (typeof item === "string" ? item : ""))
        .filter(Boolean)
        .slice(0, 4);
    }

    const llmConfidence = asFiniteNumber(llm.confidence);
    if (llmConfidence !== null) {
      result.confidence = Math.max(0, Math.min(1, llmConfidence));
    }
  }

  return result;
}

function applyAnswers(spec: ModelSpec, answers: Record<string, string | number>): ModelSpec {
  const dimensionsMm = { ...spec.dimensionsMm };
  let objectClass = spec.objectClass;
  let shape = spec.shape;

  if (typeof answers.object_class === "string") {
    const candidate = answers.object_class.trim();
    if (isObjectClass(candidate)) {
      objectClass = candidate;
      for (const [key, value] of Object.entries(DEFAULT_DIMENSIONS[candidate])) {
        if (dimensionsMm[key] === undefined) {
          dimensionsMm[key] = value;
        }
      }
    }
  }

  if (typeof answers.shape === "string") {
    const candidate = answers.shape.trim();
    if (isShape(candidate)) {
      shape = candidate;
    }
  }

  for (const [key, value] of Object.entries(answers)) {
    if (key === "object_class" || key === "shape") {
      continue;
    }
    const numeric = asFiniteNumber(value);
    if (numeric !== null) {
      dimensionsMm[key] = Number(Math.max(0.1, numeric).toFixed(3));
    }
  }

  return {
    ...spec,
    objectClass,
    shape,
    dimensionsMm
  };
}

function buildPendingQuestions(
  seed: PromptSeed,
  spec: ModelSpec,
  answers: Record<string, string | number>
): ClarificationQuestion[] {
  const pending: ClarificationQuestion[] = [];

  if (!seed.objectExplicit && answers.object_class === undefined) {
    pending.push({
      id: "object_class",
      label: "What kind of item are you making?",
      inputType: "select",
      required: true,
      options: [...OBJECT_CLASSES]
    });
  }

  if (!seed.shapeExplicit && answers.shape === undefined) {
    pending.push({
      id: "shape",
      label: "Which shape should we use?",
      inputType: "select",
      required: true,
      options: ["heart", "circle", "star", "rounded_square"]
    });
  }

  const criticalFields =
    spec.objectClass === "ring"
      ? ["outer_diameter", "band_width", "thickness"]
      : [
          "width",
          "height",
          "thickness",
          ...(spec.objectClass === "earring" || spec.objectClass === "pendant"
            ? ["hole_diameter"]
            : [])
        ];

  for (const field of criticalFields) {
    const answered = answers[field] !== undefined;
    const hasDimension = Number.isFinite(spec.dimensionsMm[field]);
    if (answered || hasDimension) {
      continue;
    }

    pending.push({
      id: field,
      label: `Please provide ${field.replaceAll("_", " ")}.`,
      inputType: "number",
      required: true,
      unit: "mm"
    });
  }

  return pending.slice(0, 4);
}

function mergeQuestions(
  questionAgentQuestions: ClarificationQuestion[],
  pendingQuestions: ClarificationQuestion[],
  answers: Record<string, string | number>,
  safety: SafetyResult
): ClarificationQuestion[] {
  const answered = new Set(Object.keys(answers));
  const merged = new Map<string, ClarificationQuestion>();

  const primary = Object.keys(answers).length > 0 ? pendingQuestions : questionAgentQuestions;
  const secondary = Object.keys(answers).length > 0 ? questionAgentQuestions : pendingQuestions;

  for (const question of [...primary, ...secondary]) {
    if (answered.has(question.id)) {
      continue;
    }
    if (!merged.has(question.id)) {
      merged.set(question.id, question);
    }
  }

  if (safety.confidence < 0.6 && !answered.has("thickness") && !merged.has("thickness")) {
    const forced = new Map<string, ClarificationQuestion>();
    forced.set("thickness", {
      id: "thickness",
      label: "Please confirm the thickness to avoid fragile prints.",
      inputType: "number",
      required: true,
      unit: "mm"
    });

    for (const [id, question] of merged.entries()) {
      forced.set(id, question);
    }

    return [...forced.values()].slice(0, 4);
  }

  return [...merged.values()].slice(0, 4);
}

function buildSummary(
  spec: ModelSpec,
  questions: ClarificationQuestion[],
  adjustments: AutoAdjustment[],
  safety: SafetyResult
): string {
  const base =
    `We interpreted your request as a ${spec.shape.replaceAll("_", " ")} ` +
    `${spec.objectClass.replaceAll("_", " ")} optimised for PLA.`;

  if (questions.length > 0) {
    return `${base} ${questions.length} clarification ${questions.length === 1 ? "question is" : "questions are"} still needed.`;
  }

  if (adjustments.length > 0) {
    return `${base} ${adjustments.length} printability adjustment ${adjustments.length === 1 ? "was" : "were"} applied.`;
  }

  if (safety.warnings.length > 0) {
    return `${base} Safety checks flagged a detail to review before generating.`;
  }

  return `${base} You can refine dimensions and generate now.`;
}

async function mergeSummaryWithLLM(fallbackSummary: string, payload: Record<string, unknown>): Promise<string> {
  const client = getOpenAIClient();
  if (!client) {
    return fallbackSummary;
  }

  try {
    const completion = await client.chat.completions.create({
      model: MERGE_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Write a concise British English summary sentence for a 3D-print assistant response. Return plain text only."
        },
        {
          role: "user",
          content: JSON.stringify({
            fallbackSummary,
            context: payload
          })
        }
      ]
    });

    const candidate = completion.choices[0]?.message?.content?.trim();
    if (!candidate) {
      return fallbackSummary;
    }

    return candidate.slice(0, 260);
  } catch {
    return fallbackSummary;
  }
}

export async function orchestrateInterpretation(input: OrchestrationInput): Promise<InterpretResponse> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const answers = input.answers ?? {};
  const seed = parsePrompt(prompt);

  const [intent, geometry, manufacturability, question, slicing, safety] = await Promise.all([
    intentAgent(prompt, seed),
    geometryAgent(prompt, seed),
    manufacturabilityAgent(prompt, seed),
    questionAgent(prompt, seed),
    slicingAgent(prompt, seed),
    safetyAgent(prompt, seed)
  ]);

  const defaultSpec: ModelSpec = {
    objectClass: intent.objectClass,
    shape: geometry.shape,
    dimensionsMm: {
      ...DEFAULT_DIMENSIONS[intent.objectClass],
      ...geometry.dimensionsMm
    },
    featureFlags: geometry.featureFlags,
    printerProfile: slicing.printerProfile
  };

  const seededSpec = normaliseSpec(input.draftSpec, defaultSpec);
  const answeredSpec = applyAnswers(seededSpec, answers);
  const constrained = applyPrintabilityConstraints(answeredSpec, { maxDimensionsMm: 120 });

  const pendingQuestions = buildPendingQuestions(seed, constrained.spec, answers);
  const questions = mergeQuestions(question.questions, pendingQuestions, answers, safety);

  const fallbackSummary = buildSummary(
    constrained.spec,
    questions,
    constrained.adjustments,
    safety
  );

  const summary = await mergeSummaryWithLLM(fallbackSummary, {
    intent,
    manufacturability,
    safety,
    questionCount: questions.length,
    adjustments: constrained.adjustments
  });

  return {
    summary,
    questions,
    modelSpec: {
      ...constrained.spec,
      printerProfile: slicing.printerProfile
    },
    adjustments: constrained.adjustments
  };
}
