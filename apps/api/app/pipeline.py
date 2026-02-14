from __future__ import annotations

import json
import math
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from .schemas import ModelSpec

try:
    import cadquery as cq  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    cq = None


def _box_triangles(width: float, depth: float, height: float) -> List[Tuple[Tuple[float, float, float], ...]]:
    x = width / 2
    y = depth / 2
    z = height

    v = [
        (-x, -y, 0),
        (x, -y, 0),
        (x, y, 0),
        (-x, y, 0),
        (-x, -y, z),
        (x, -y, z),
        (x, y, z),
        (-x, y, z),
    ]

    faces = [
        (0, 1, 2),
        (0, 2, 3),
        (4, 7, 6),
        (4, 6, 5),
        (0, 4, 5),
        (0, 5, 1),
        (1, 5, 6),
        (1, 6, 2),
        (2, 6, 7),
        (2, 7, 3),
        (3, 7, 4),
        (3, 4, 0),
    ]

    return [(v[a], v[b], v[c]) for a, b, c in faces]


def _normal(triangle: Sequence[Tuple[float, float, float]]) -> Tuple[float, float, float]:
    a, b, c = triangle
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return (nx / length, ny / length, nz / length)


def write_fallback_stl(spec: ModelSpec, output_path: Path) -> None:
    dims = spec.dimensionsMm
    width = float(dims.get("width", dims.get("outer_diameter", 20.0)))
    depth = float(dims.get("height", dims.get("band_width", width)))
    height = float(dims.get("thickness", 2.0))

    triangles = _box_triangles(width, depth, height)
    with output_path.open("w", encoding="utf-8") as handle:
        handle.write("solid fallback_model\n")
        for tri in triangles:
            nx, ny, nz = _normal(tri)
            handle.write(f"  facet normal {nx:.6f} {ny:.6f} {nz:.6f}\n")
            handle.write("    outer loop\n")
            for vx, vy, vz in tri:
                handle.write(f"      vertex {vx:.6f} {vy:.6f} {vz:.6f}\n")
            handle.write("    endloop\n")
            handle.write("  endfacet\n")
        handle.write("endsolid fallback_model\n")


def _star_points(radius_outer: float, radius_inner: float, points: int = 5) -> List[Tuple[float, float]]:
    coords: List[Tuple[float, float]] = []
    for i in range(points * 2):
        angle = (math.pi / points) * i - math.pi / 2
        radius = radius_outer if i % 2 == 0 else radius_inner
        coords.append((radius * math.cos(angle), radius * math.sin(angle)))
    coords.append(coords[0])
    return coords


def build_cadquery_solid(spec: ModelSpec):
    if cq is None:
        raise RuntimeError("CadQuery is not installed")

    dims = spec.dimensionsMm
    thickness = float(dims.get("thickness", 2.0))
    width = float(dims.get("width", dims.get("outer_diameter", 20.0)))
    height = float(dims.get("height", width))
    hole_diameter = float(dims.get("hole_diameter", 2.0))

    if spec.objectClass == "ring":
        outer = float(dims.get("outer_diameter", 22.0))
        band = float(dims.get("band_width", 4.0))
        inner = max(outer - 2 * band, 10.0)
        return (
            cq.Workplane("XY")
            .circle(outer / 2)
            .circle(inner / 2)
            .extrude(thickness)
            .edges("|Z")
            .fillet(min(0.4, thickness / 3))
        )

    if spec.objectClass == "fidget_spinner":
        base = cq.Workplane("XY").circle(width / 7).extrude(thickness)
        arm_radius = width / 6
        offset = width / 3
        for angle in (0, 120, 240):
            radians = math.radians(angle)
            x = offset * math.cos(radians)
            y = offset * math.sin(radians)
            base = base.union(cq.Workplane("XY").center(x, y).circle(arm_radius).extrude(thickness))
        return base.edges("|Z").fillet(min(0.6, thickness / 2))

    if spec.shape == "circle":
        shape = cq.Workplane("XY").circle(width / 2)
    elif spec.shape == "rounded_square":
        radius = min(width, height) * 0.12
        shape = cq.Workplane("XY").rect(width, height).vertices().fillet(radius)
    elif spec.shape == "star":
        points = _star_points(radius_outer=width / 2, radius_inner=width / 4)
        shape = cq.Workplane("XY").polyline(points).close()
    elif spec.shape == "heart":
        r = min(width, height) / 4
        lobe_y = r * 0.35
        left = cq.Workplane("XY").center(-r, lobe_y).circle(r)
        right = cq.Workplane("XY").center(r, lobe_y).circle(r)
        point = cq.Workplane("XY").polyline([(0, -height / 2), (-width / 2, 0), (width / 2, 0)]).close()
        shape = left.union(right).union(point)
    else:
        shape = cq.Workplane("XY").rect(width, height)

    solid = shape.extrude(thickness)

    if spec.objectClass in {"earring", "pendant"}:
        y_hole = height / 2 - max(hole_diameter * 1.3, 1.8)
        solid = solid.faces(">Z").workplane().pushPoints([(0.0, y_hole)]).hole(hole_diameter)

    return solid.edges("|Z").fillet(min(0.6, thickness / 2))


def export_stl(spec: ModelSpec, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if cq is None:
        write_fallback_stl(spec, output_path)
        return

    try:
        solid = build_cadquery_solid(spec)
        cq.exporters.export(solid, str(output_path), tolerance=0.05, angularTolerance=0.1)
    except Exception:
        write_fallback_stl(spec, output_path)


def validate_stl(stl_path: Path) -> Dict[str, float]:
    if not stl_path.exists():
        raise RuntimeError("STL file was not produced")

    size = stl_path.stat().st_size
    if size < 200:
        raise RuntimeError("STL file appears invalid: file too small")

    return {"bytes": float(size)}


def _profile_files(profile: str, profile_dir: Path) -> Tuple[Path, Path, Path]:
    prefix = profile.split("_", maxsplit=1)[0]
    machine = profile_dir / f"{prefix}.machine.json"
    process = profile_dir / "PLA.process.json"
    filament = profile_dir / "PLA.filament.json"

    for path in (machine, process, filament):
        if not path.exists():
            raise RuntimeError(f"Missing profile file: {path}")

    return machine, process, filament


def slice_with_bambu_cli(
    stl_path: Path,
    output_3mf: Path,
    profile: str,
    profile_dir: Path,
    timeout_s: int,
) -> Dict[str, str]:
    bambu_exe = shutil.which("bambu-studio")
    if not bambu_exe:
        raise RuntimeError("bambu-studio executable not found")

    machine, process, filament = _profile_files(profile, profile_dir)
    settings_value = f"{machine};{process}"

    cmd = [
        bambu_exe,
        "--orient",
        "--arrange",
        "1",
        "--load-settings",
        settings_value,
        "--load-filaments",
        str(filament),
        "--slice",
        "0",
        "--export-3mf",
        str(output_3mf),
        str(stl_path),
    ]

    run = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )

    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip() or "Bambu Studio CLI returned a non-zero exit code")

    if not output_3mf.exists():
        raise RuntimeError("Bambu Studio CLI completed without producing a 3MF file")

    return {
        "engine": "bambu-studio",
        "stdout": run.stdout[-2000:],
    }


def write_placeholder_3mf(output_3mf: Path, stl_path: Path) -> None:
    output_3mf.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_3mf, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            """<?xml version='1.0' encoding='UTF-8'?>
<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>
  <Default Extension='model' ContentType='application/vnd.ms-package.3dmanufacturing-3dmodel+xml'/>
  <Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/>
</Types>
""",
        )
        archive.writestr(
            "_rels/.rels",
            """<?xml version='1.0' encoding='UTF-8'?>
<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>
  <Relationship Target='/3D/3dmodel.model' Id='rel0' Type='http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'/>
</Relationships>
""",
        )
        archive.writestr(
            "3D/3dmodel.model",
            """<?xml version='1.0' encoding='UTF-8'?>
<model unit='millimeter' xml:lang='en-GB' xmlns='http://schemas.microsoft.com/3dmanufacturing/core/2015/02'>
  <resources>
    <object id='1' type='model'><mesh><vertices/></mesh></object>
  </resources>
  <build>
    <item objectid='1'/>
  </build>
</model>
""",
        )
        archive.write(stl_path, arcname="Attachments/model.stl")


def write_report(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
