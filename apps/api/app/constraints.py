from __future__ import annotations

from typing import Dict, List, Tuple

from .schemas import AutoAdjustment, ModelSpec

OBJECT_THICKNESS_FLOOR_MM = {
    "earring": 1.8,
    "pendant": 2.0,
    "ring": 2.0,
    "fidget_token": 3.0,
    "fidget_spinner": 5.0,
}


def _set_if_adjusted(
    dimensions: Dict[str, float],
    field: str,
    minimum: float,
    reason: str,
    adjustments: List[AutoAdjustment],
) -> None:
    value = dimensions.get(field)
    if value is None:
        return
    if value >= minimum:
        return
    adjustments.append(
        AutoAdjustment(field=field, **{"from": round(value, 3)}, to=minimum, reason=reason)
    )
    dimensions[field] = minimum


def apply_printability_constraints(
    spec: ModelSpec,
    max_dimensions_mm: float,
) -> Tuple[ModelSpec, List[AutoAdjustment]]:
    dimensions = dict(spec.dimensionsMm)
    adjustments: List[AutoAdjustment] = []

    _set_if_adjusted(
        dimensions,
        "thickness",
        max(1.2, OBJECT_THICKNESS_FLOOR_MM.get(spec.objectClass, 1.2)),
        "Raised to a print-safe thickness for PLA reliability.",
        adjustments,
    )

    _set_if_adjusted(
        dimensions,
        "emboss_depth",
        0.6,
        "Raised embossed depth to maintain visible detail after slicing.",
        adjustments,
    )

    _set_if_adjusted(
        dimensions,
        "deboss_depth",
        0.6,
        "Raised debossed depth to maintain visible detail after slicing.",
        adjustments,
    )

    _set_if_adjusted(
        dimensions,
        "hole_diameter",
        1.6,
        "Raised hole diameter to reduce failed bridges and brittle edges.",
        adjustments,
    )

    for field in ("width", "height", "outer_diameter"):
        value = dimensions.get(field)
        if value is None:
            continue
        if value <= max_dimensions_mm:
            continue
        adjustments.append(
            AutoAdjustment(
                field=field,
                **{"from": round(value, 3)},
                to=max_dimensions_mm,
                reason="Reduced dimension to the configured maximum printable size.",
            )
        )
        dimensions[field] = max_dimensions_mm

    updated = spec.model_copy(update={"dimensionsMm": dimensions})
    return updated, adjustments
