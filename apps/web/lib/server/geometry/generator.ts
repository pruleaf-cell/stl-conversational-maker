import earcut from "earcut";
import type { ModelSpec, PrinterProfile, Shape } from "@stl-maker/contracts";
import { writeAsciiStl, type Triangle, type Vec3 } from "./stl";

interface Vec2 {
  x: number;
  y: number;
}

interface SlicingGuide {
  profile: string;
  notes: string[];
  recommendedSteps: string[];
}

function asFinite(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function circlePoints(
  radiusX: number,
  radiusY: number,
  segments: number,
  centre: Vec2 = { x: 0, y: 0 }
): Vec2[] {
  const points: Vec2[] = [];
  for (let index = 0; index < segments; index += 1) {
    const theta = (index / segments) * Math.PI * 2;
    points.push({
      x: centre.x + radiusX * Math.cos(theta),
      y: centre.y + radiusY * Math.sin(theta)
    });
  }
  return points;
}

function signedArea(points: Vec2[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

function enforceOrientation(points: Vec2[], clockwise: boolean): Vec2[] {
  const area = signedArea(points);
  const isClockwise = area < 0;
  if (isClockwise === clockwise) {
    return points;
  }
  return [...points].reverse();
}

function roundedSquareOutline(width: number, height: number): Vec2[] {
  const radius = Math.max(0.8, Math.min(width, height) * 0.14);
  const stepCount = 8;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const x = halfWidth - radius;
  const y = halfHeight - radius;

  const corners = [
    { centre: { x, y }, start: -Math.PI / 2, end: 0 },
    { centre: { x, y: -y }, start: 0, end: Math.PI / 2 },
    { centre: { x: -x, y: -y }, start: Math.PI / 2, end: Math.PI },
    { centre: { x: -x, y }, start: Math.PI, end: (Math.PI * 3) / 2 }
  ];

  const points: Vec2[] = [];
  for (const corner of corners) {
    for (let step = 0; step < stepCount; step += 1) {
      const ratio = step / stepCount;
      const theta = corner.start + (corner.end - corner.start) * ratio;
      points.push({
        x: corner.centre.x + radius * Math.cos(theta),
        y: corner.centre.y + radius * Math.sin(theta)
      });
    }
  }

  return points;
}

function starOutline(width: number, height: number): Vec2[] {
  const radiusOuter = Math.min(width, height) / 2;
  const radiusInner = radiusOuter * 0.45;
  const points: Vec2[] = [];

  for (let index = 0; index < 10; index += 1) {
    const theta = (Math.PI / 5) * index - Math.PI / 2;
    const radius = index % 2 === 0 ? radiusOuter : radiusInner;
    points.push({
      x: radius * Math.cos(theta),
      y: radius * Math.sin(theta)
    });
  }

  return points;
}

function heartOutline(width: number, height: number): Vec2[] {
  const samples = 120;
  const raw: Vec2[] = [];

  for (let index = 0; index < samples; index += 1) {
    const theta = (index / samples) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(theta), 3);
    const y =
      13 * Math.cos(theta) -
      5 * Math.cos(2 * theta) -
      2 * Math.cos(3 * theta) -
      Math.cos(4 * theta);
    raw.push({ x, y });
  }

  const minX = Math.min(...raw.map((point) => point.x));
  const maxX = Math.max(...raw.map((point) => point.x));
  const minY = Math.min(...raw.map((point) => point.y));
  const maxY = Math.max(...raw.map((point) => point.y));

  const sourceWidth = maxX - minX || 1;
  const sourceHeight = maxY - minY || 1;

  return raw.map((point) => ({
    x: ((point.x - minX) / sourceWidth - 0.5) * width,
    y: ((point.y - minY) / sourceHeight - 0.5) * height
  }));
}

function spinnerOutline(width: number, height: number): Vec2[] {
  const diameter = Math.min(width, height);
  const samples = 180;
  const core = diameter * 0.23;
  const lobe = diameter * 0.17;

  const points: Vec2[] = [];
  for (let index = 0; index < samples; index += 1) {
    const theta = (index / samples) * Math.PI * 2;
    const pulse = Math.max(0, Math.cos(theta * 3));
    const radius = core + lobe * Math.pow(pulse, 1.7);
    points.push({
      x: radius * Math.cos(theta),
      y: radius * Math.sin(theta)
    });
  }

  return points;
}

function shapeOutline(shape: Shape, width: number, height: number): Vec2[] {
  if (shape === "heart") {
    return heartOutline(width, height);
  }

  if (shape === "star") {
    return starOutline(width, height);
  }

  if (shape === "rounded_square") {
    return roundedSquareOutline(width, height);
  }

  return circlePoints(width / 2, height / 2, 96);
}

function toVec3(point: Vec2, z: number): Vec3 {
  return { x: point.x, y: point.y, z };
}

function extrudePolygon(outerRaw: Vec2[], holesRaw: Vec2[][], thickness: number): Triangle[] {
  const outer = enforceOrientation(outerRaw, false);
  const holes = holesRaw.map((hole) => enforceOrientation(hole, true));

  const flattened: number[] = [];
  const allPoints: Vec2[] = [];

  for (const point of outer) {
    flattened.push(point.x, point.y);
    allPoints.push(point);
  }

  const holeIndices: number[] = [];
  for (const hole of holes) {
    holeIndices.push(allPoints.length);
    for (const point of hole) {
      flattened.push(point.x, point.y);
      allPoints.push(point);
    }
  }

  const indices = earcut(flattened, holeIndices, 2);
  const triangles: Triangle[] = [];

  for (let index = 0; index < indices.length; index += 3) {
    const a = allPoints[indices[index]];
    const b = allPoints[indices[index + 1]];
    const c = allPoints[indices[index + 2]];

    triangles.push([toVec3(a, thickness), toVec3(b, thickness), toVec3(c, thickness)]);
    triangles.push([toVec3(a, 0), toVec3(c, 0), toVec3(b, 0)]);
  }

  const loops = [outer, ...holes];
  for (const loop of loops) {
    for (let index = 0; index < loop.length; index += 1) {
      const current = loop[index];
      const next = loop[(index + 1) % loop.length];

      const b0 = toVec3(current, 0);
      const b1 = toVec3(next, 0);
      const t0 = toVec3(current, thickness);
      const t1 = toVec3(next, thickness);

      triangles.push([b0, b1, t1]);
      triangles.push([b0, t1, t0]);
    }
  }

  return triangles;
}

function buildRingTriangles(dimensions: Record<string, number>, thickness: number): Triangle[] {
  const outerDiameter = asFinite(dimensions.outer_diameter, 22);
  const bandWidth = asFinite(dimensions.band_width, 4);
  const innerDiameter = Math.max(outerDiameter - bandWidth * 2, 8);

  const outer = circlePoints(outerDiameter / 2, outerDiameter / 2, 128);
  const inner = circlePoints(innerDiameter / 2, innerDiameter / 2, 96);

  return extrudePolygon(outer, [inner], thickness);
}

function buildFlatShapeTriangles(spec: ModelSpec, thickness: number): Triangle[] {
  const dimensions = spec.dimensionsMm;
  const width = asFinite(dimensions.width ?? dimensions.outer_diameter, 24);
  const height = asFinite(dimensions.height, width);

  const outer =
    spec.objectClass === "fidget_spinner"
      ? spinnerOutline(width, height)
      : shapeOutline(spec.shape, width, height);

  const holes: Vec2[][] = [];

  if (spec.objectClass === "earring" || spec.objectClass === "pendant") {
    const holeDiameter = Math.max(1.6, asFinite(dimensions.hole_diameter, 2));
    const centreY = height / 2 - Math.max(holeDiameter * 1.2, 2);
    holes.push(circlePoints(holeDiameter / 2, holeDiameter / 2, 48, { x: 0, y: centreY }));
  }

  if (spec.objectClass === "fidget_spinner") {
    const centreHoleDiameter = Math.max(6, asFinite(dimensions.hole_diameter, 22));
    holes.push(circlePoints(centreHoleDiameter / 2, centreHoleDiameter / 2, 64));
  }

  return extrudePolygon(outer, holes, thickness);
}

function sanitiseFileStem(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function generateStl(spec: ModelSpec): { fileName: string; stlAscii: string } {
  const thickness = Math.max(0.8, asFinite(spec.dimensionsMm.thickness, 2));

  const triangles =
    spec.objectClass === "ring"
      ? buildRingTriangles(spec.dimensionsMm, thickness)
      : buildFlatShapeTriangles(spec, thickness);

  const fileName = `${sanitiseFileStem(`${spec.objectClass}-${spec.shape}`)}.stl`;
  const stlAscii = writeAsciiStl(fileName.replace(/\.stl$/i, ""), triangles);

  return {
    fileName,
    stlAscii
  };
}

export function buildSlicingGuide(profile: PrinterProfile): SlicingGuide {
  const machineNotes: Record<PrinterProfile, string> = {
    "A1_PLA_0.4": "Good default profile for lightweight jewellery and tokens.",
    "P1_PLA_0.4": "Stable choice for slightly faster infill and thicker parts.",
    "X1_PLA_0.4": "High consistency profile for detail-focused prints."
  };

  return {
    profile,
    notes: [
      machineNotes[profile],
      "Use PLA with a 0.4 mm nozzle.",
      "If tiny features look fragile, reduce print speed by 15%."
    ],
    recommendedSteps: [
      "Open Bambu Studio and import the STL file.",
      `Select printer preset ${profile} and a standard PLA filament profile.`,
      "Use 0.20 mm layer height, 3 walls, and 15% gyroid infill as a starting point.",
      "Check orientation and supports, then slice and preview bridges around holes.",
      "Export or send the sliced job to your printer."
    ]
  };
}
