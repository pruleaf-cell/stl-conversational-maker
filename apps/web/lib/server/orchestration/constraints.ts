import type { AutoAdjustment, ModelSpec, ObjectClass } from "@stl-maker/contracts";

const OBJECT_THICKNESS_FLOOR_MM: Record<ObjectClass, number> = {
  earring: 1.8,
  pendant: 2,
  ring: 2,
  fidget_token: 3,
  fidget_spinner: 5
};

export interface ConstraintOptions {
  maxDimensionsMm?: number;
}

function asFinite(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function setIfAdjusted(
  dimensions: Record<string, number>,
  field: string,
  minimum: number,
  reason: string,
  adjustments: AutoAdjustment[]
): void {
  const current = asFinite(dimensions[field]);
  if (current === null || current >= minimum) {
    return;
  }

  dimensions[field] = minimum;
  adjustments.push({
    field,
    from: Number(current.toFixed(3)),
    to: minimum,
    reason
  });
}

export function applyPrintabilityConstraints(
  spec: ModelSpec,
  options: ConstraintOptions = {}
): { spec: ModelSpec; adjustments: AutoAdjustment[] } {
  const maxDimensionsMm = options.maxDimensionsMm ?? 120;
  const dimensions = { ...spec.dimensionsMm };
  const adjustments: AutoAdjustment[] = [];

  setIfAdjusted(
    dimensions,
    "thickness",
    Math.max(1.2, OBJECT_THICKNESS_FLOOR_MM[spec.objectClass]),
    "Raised to a print-safe thickness for PLA reliability.",
    adjustments
  );

  setIfAdjusted(
    dimensions,
    "emboss_depth",
    0.6,
    "Raised embossed depth to maintain visible detail after slicing.",
    adjustments
  );

  setIfAdjusted(
    dimensions,
    "deboss_depth",
    0.6,
    "Raised debossed depth to maintain visible detail after slicing.",
    adjustments
  );

  setIfAdjusted(
    dimensions,
    "hole_diameter",
    1.6,
    "Raised hole diameter to reduce failed bridges and brittle edges.",
    adjustments
  );

  setIfAdjusted(
    dimensions,
    "band_width",
    1.2,
    "Raised band width to avoid weak ring walls.",
    adjustments
  );

  for (const field of ["width", "height", "outer_diameter"]) {
    const current = asFinite(dimensions[field]);
    if (current === null || current <= maxDimensionsMm) {
      continue;
    }

    dimensions[field] = maxDimensionsMm;
    adjustments.push({
      field,
      from: Number(current.toFixed(3)),
      to: maxDimensionsMm,
      reason: "Reduced dimension to the configured maximum printable size."
    });
  }

  return {
    spec: {
      ...spec,
      dimensionsMm: dimensions
    },
    adjustments
  };
}
