export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Triangle = [Vec3, Vec3, Vec3];

function normalise(value: Vec3): Vec3 {
  const length = Math.sqrt(value.x * value.x + value.y * value.y + value.z * value.z) || 1;
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length
  };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function triangleNormal(triangle: Triangle): Vec3 {
  const [a, b, c] = triangle;
  const u = subtract(b, a);
  const v = subtract(c, a);
  return normalise(cross(u, v));
}

function formatVertex(vertex: Vec3): string {
  return `${vertex.x.toFixed(6)} ${vertex.y.toFixed(6)} ${vertex.z.toFixed(6)}`;
}

export function writeAsciiStl(name: string, triangles: Triangle[]): string {
  const lines: string[] = [`solid ${name}`];

  for (const triangle of triangles) {
    const normal = triangleNormal(triangle);
    lines.push(
      `  facet normal ${normal.x.toFixed(6)} ${normal.y.toFixed(6)} ${normal.z.toFixed(6)}`,
      "    outer loop",
      `      vertex ${formatVertex(triangle[0])}`,
      `      vertex ${formatVertex(triangle[1])}`,
      `      vertex ${formatVertex(triangle[2])}`,
      "    endloop",
      "  endfacet"
    );
  }

  lines.push(`endsolid ${name}`);
  return lines.join("\n");
}
