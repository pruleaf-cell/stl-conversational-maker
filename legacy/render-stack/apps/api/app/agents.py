from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

from .constraints import apply_printability_constraints
from .schemas import ClarificationQuestion, ModelSpec

try:
    from openai import AsyncOpenAI
except Exception:  # pragma: no cover - optional dependency during tests
    AsyncOpenAI = None

DIMENSION_PATTERN = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>mm|millimetres?|millimeters?|cm|inches?|inch|in)\b",
    re.IGNORECASE,
)

OBJECT_KEYWORDS = {
    "earring": "earring",
    "pendant": "pendant",
    "ring": "ring",
    "fidget spinner": "fidget_spinner",
    "spinner": "fidget_spinner",
    "fidget token": "fidget_token",
    "token": "fidget_token",
}

SHAPE_KEYWORDS = {
    "heart": "heart",
    "circle": "circle",
    "round": "circle",
    "star": "star",
    "rounded square": "rounded_square",
    "square": "rounded_square",
}

DEFAULT_DIMENSIONS = {
    "earring": {"width": 20.0, "height": 20.0, "thickness": 2.0, "hole_diameter": 2.0},
    "pendant": {"width": 30.0, "height": 30.0, "thickness": 2.4, "hole_diameter": 2.2},
    "ring": {"outer_diameter": 22.0, "band_width": 4.0, "thickness": 2.0},
    "fidget_token": {"width": 35.0, "height": 35.0, "thickness": 3.0},
    "fidget_spinner": {"width": 65.0, "height": 65.0, "thickness": 5.0, "hole_diameter": 22.0},
}

OPENAI_SPECIALIST_MODEL = os.getenv("OPENAI_SPECIALIST_MODEL", "gpt-5-mini")
_OPENAI_CLIENT = (
    AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    if AsyncOpenAI is not None and os.getenv("OPENAI_API_KEY")
    else None
)


@dataclass
class PromptSeed:
    object_class: str
    object_explicit: bool
    shape: str
    shape_explicit: bool
    dimensions: Dict[str, float]
    dimension_fields_explicit: Set[str]


@dataclass
class OrchestrationResult:
    summary: str
    spec: ModelSpec
    questions: List[ClarificationQuestion]
    adjustments: List[Any]


def _normalise_length(value: float, unit: str) -> float:
    unit = unit.lower()
    if unit.startswith("cm"):
        return value * 10.0
    if unit.startswith("in"):
        return value * 25.4
    return value


def _pick_keyword(prompt_lower: str, mapping: Dict[str, str], fallback: str) -> Tuple[str, bool]:
    for key, value in mapping.items():
        if key in prompt_lower:
            return value, True
    return fallback, False


def _capture_dimensions(prompt: str) -> Tuple[Dict[str, float], Set[str]]:
    lower = prompt.lower()
    dimensions: Dict[str, float] = {}
    explicit_fields: Set[str] = set()

    for match in DIMENSION_PATTERN.finditer(prompt):
        raw_value = float(match.group("value"))
        value = round(_normalise_length(raw_value, match.group("unit")), 3)

        window_start = max(0, match.start() - 24)
        window_end = min(len(lower), match.end() + 24)
        window = lower[window_start:window_end]

        field: Optional[str] = None
        if any(token in window for token in ("deep", "thick", "thickness", "depth")):
            field = "thickness"
        elif "hole" in window and "diam" in window:
            field = "hole_diameter"
        elif "hole" in window:
            field = "hole_diameter"
        elif "outer" in window and "diam" in window:
            field = "outer_diameter"
        elif "diam" in window:
            field = "width" if "width" not in dimensions else "height"
        elif "width" in window:
            field = "width"
        elif "height" in window:
            field = "height"

        if field is None:
            if "thickness" not in dimensions:
                field = "thickness"
            elif "width" not in dimensions:
                field = "width"
            elif "height" not in dimensions:
                field = "height"
            else:
                field = "feature_size"

        dimensions[field] = value
        explicit_fields.add(field)

    return dimensions, explicit_fields


def parse_prompt(prompt: str) -> PromptSeed:
    lower = prompt.lower()
    object_class, object_explicit = _pick_keyword(lower, OBJECT_KEYWORDS, "pendant")
    shape, shape_explicit = _pick_keyword(lower, SHAPE_KEYWORDS, "circle")
    dimensions, explicit = _capture_dimensions(prompt)

    return PromptSeed(
        object_class=object_class,
        object_explicit=object_explicit,
        shape=shape,
        shape_explicit=shape_explicit,
        dimensions=dimensions,
        dimension_fields_explicit=explicit,
    )


async def _call_specialist_llm(
    *,
    agent_name: str,
    prompt: str,
    seed: PromptSeed,
    expected_schema: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    if _OPENAI_CLIENT is None:
        return None

    system = (
        f"You are {agent_name} for a 3D-print assistant. "
        "Respond in strict JSON only. Use British English where text is present."
    )
    user = {
        "prompt": prompt,
        "seed": asdict(seed),
        "expected_schema": expected_schema,
    }

    try:
        completion = await _OPENAI_CLIENT.chat.completions.create(
            model=OPENAI_SPECIALIST_MODEL,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user)},
            ],
        )
        raw = completion.choices[0].message.content or "{}"
        payload = json.loads(raw)
        if isinstance(payload, dict):
            return payload
    except Exception:
        return None
    return None


async def _intent_agent(prompt: str, seed: PromptSeed) -> Dict[str, Any]:
    await asyncio.sleep(0)
    result = {
        "objectClass": seed.object_class,
        "shape": seed.shape,
        "confidence": 0.84 if seed.object_explicit else 0.58,
    }
    llm = await _call_specialist_llm(
        agent_name="IntentAgent",
        prompt=prompt,
        seed=seed,
        expected_schema={
            "objectClass": "earring|pendant|ring|fidget_token|fidget_spinner",
            "shape": "heart|circle|star|rounded_square|custom_outline",
            "confidence": "0-1",
        },
    )
    if llm:
        result.update({k: v for k, v in llm.items() if k in result})
    return result


async def _geometry_agent(prompt: str, seed: PromptSeed) -> Dict[str, Any]:
    await asyncio.sleep(0)
    base = dict(DEFAULT_DIMENSIONS.get(seed.object_class, DEFAULT_DIMENSIONS["pendant"]))
    base.update(seed.dimensions)
    result = {
        "dimensionsMm": base,
        "featureFlags": {
            "mirror": False,
            "add_loop": seed.object_class in {"earring", "pendant"},
            "rounded_edges": True,
        },
        "shape": seed.shape,
    }
    llm = await _call_specialist_llm(
        agent_name="GeometryAgent",
        prompt=prompt,
        seed=seed,
        expected_schema={
            "dimensionsMm": {"thickness": 2.0, "width": 20.0, "height": 20.0},
            "featureFlags": {"rounded_edges": True},
            "shape": "heart|circle|star|rounded_square|custom_outline",
        },
    )
    if llm:
        if isinstance(llm.get("dimensionsMm"), dict):
            result["dimensionsMm"].update(llm["dimensionsMm"])
        if isinstance(llm.get("featureFlags"), dict):
            result["featureFlags"].update(llm["featureFlags"])
        if isinstance(llm.get("shape"), str):
            result["shape"] = llm["shape"]
    return result


async def _manufacturability_agent(prompt: str, seed: PromptSeed) -> Dict[str, Any]:
    await asyncio.sleep(0)
    result = {
        "minimums": {
            "thickness": 1.2,
            "emboss_depth": 0.6,
            "deboss_depth": 0.6,
            "hole_diameter": 1.6,
        },
        "notes": [
            "Apply PLA-safe minimums for thin features.",
            "Keep small jewellery geometry under practical bridge lengths.",
        ],
    }
    llm = await _call_specialist_llm(
        agent_name="ManufacturabilityAgent",
        prompt=prompt,
        seed=seed,
        expected_schema={
            "minimums": {"thickness": 1.2, "hole_diameter": 1.6},
            "notes": ["string"],
        },
    )
    if llm:
        if isinstance(llm.get("minimums"), dict):
            result["minimums"].update(llm["minimums"])
        if isinstance(llm.get("notes"), list):
            result["notes"] = [str(item) for item in llm["notes"]][:3]
    return result


async def _question_agent(prompt: str, seed: PromptSeed) -> Dict[str, Any]:
    await asyncio.sleep(0)
    questions: List[ClarificationQuestion] = []

    if not seed.object_explicit:
        questions.append(
            ClarificationQuestion(
                id="object_class",
                label="What kind of item are you making?",
                inputType="select",
                options=["earring", "pendant", "ring", "fidget_token", "fidget_spinner"],
            )
        )

    if not seed.shape_explicit:
        questions.append(
            ClarificationQuestion(
                id="shape",
                label="Which shape should we use?",
                inputType="select",
                options=["heart", "circle", "star", "rounded_square"],
            )
        )

    for field, label in (
        ("width", "What width should it be?"),
        ("height", "What height should it be?"),
        ("thickness", "What thickness should it be?"),
    ):
        if field not in seed.dimension_fields_explicit:
            questions.append(
                ClarificationQuestion(id=field, label=label, inputType="number", unit="mm")
            )

    if seed.object_class in {"earring", "pendant", "fidget_spinner"}:
        if "hole_diameter" not in seed.dimension_fields_explicit:
            questions.append(
                ClarificationQuestion(
                    id="hole_diameter",
                    label="What hole diameter would you like?",
                    inputType="number",
                    unit="mm",
                )
            )

    result = {
        "questions": questions[:4],
    }
    llm = await _call_specialist_llm(
        agent_name="QuestionAgent",
        prompt=prompt,
        seed=seed,
        expected_schema={
            "questions": [
                {"id": "thickness", "label": "string", "inputType": "number", "required": True, "unit": "mm"}
            ]
        },
    )
    if llm and isinstance(llm.get("questions"), list):
        parsed_questions: List[ClarificationQuestion] = []
        for item in llm["questions"][:4]:
            if not isinstance(item, dict):
                continue
            try:
                parsed_questions.append(ClarificationQuestion.model_validate(item))
            except Exception:
                continue
        if parsed_questions:
            result["questions"] = parsed_questions
    return result


async def _slicing_agent(prompt: str, seed: PromptSeed) -> Dict[str, Any]:
    await asyncio.sleep(0)
    profile = "A1_PLA_0.4"
    if seed.object_class == "fidget_spinner":
        profile = "P1_PLA_0.4"
    result = {"printerProfile": profile, "material": "PLA"}
    llm = await _call_specialist_llm(
        agent_name="SlicingAgent",
        prompt=prompt,
        seed=seed,
        expected_schema={"printerProfile": "A1_PLA_0.4|P1_PLA_0.4|X1_PLA_0.4", "material": "PLA"},
    )
    if llm:
        if llm.get("printerProfile") in {"A1_PLA_0.4", "P1_PLA_0.4", "X1_PLA_0.4"}:
            result["printerProfile"] = llm["printerProfile"]
        if isinstance(llm.get("material"), str):
            result["material"] = llm["material"]
    return result


async def _safety_agent(prompt: str, seed: PromptSeed) -> Dict[str, Any]:
    await asyncio.sleep(0)
    warnings: List[str] = []
    confidence = 0.92

    if "thickness" in seed.dimensions and seed.dimensions["thickness"] < 1.2:
        warnings.append("Requested thickness is below the safe PLA minimum.")
        confidence -= 0.2

    if "knife" in seed.object_class:
        warnings.append("Potentially unsafe object class detected.")
        confidence = min(confidence, 0.3)

    result = {"warnings": warnings, "confidence": max(confidence, 0.1)}
    llm = await _call_specialist_llm(
        agent_name="SafetyAgent",
        prompt=prompt,
        seed=seed,
        expected_schema={"warnings": ["string"], "confidence": "0-1"},
    )
    if llm:
        if isinstance(llm.get("warnings"), list):
            result["warnings"] = [str(item) for item in llm["warnings"]][:4]
        if isinstance(llm.get("confidence"), (float, int)):
            result["confidence"] = max(min(float(llm["confidence"]), 1.0), 0.0)
    return result


def _build_summary(spec: ModelSpec, questions: List[ClarificationQuestion]) -> str:
    base = (
        f"We interpreted your request as a {spec.shape.replace('_', ' ')} "
        f"{spec.objectClass.replace('_', ' ')} optimised for PLA."
    )
    if questions:
        return base + " A few details are still needed before generation."
    return base + " You can refine dimensions and build now."


def _apply_answers(spec: ModelSpec, answers: Dict[str, Any]) -> ModelSpec:
    dimensions = dict(spec.dimensionsMm)
    object_class = spec.objectClass
    shape = spec.shape

    if "object_class" in answers:
        value = str(answers["object_class"]).strip()
        if value in DEFAULT_DIMENSIONS:
            object_class = value
            for key, dim in DEFAULT_DIMENSIONS[value].items():
                dimensions.setdefault(key, dim)

    if "shape" in answers:
        value = str(answers["shape"]).strip()
        if value in {"heart", "circle", "star", "rounded_square", "custom_outline"}:
            shape = value

    for key, raw_value in answers.items():
        if key in {"object_class", "shape"}:
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        dimensions[key] = value

    return spec.model_copy(update={"objectClass": object_class, "shape": shape, "dimensionsMm": dimensions})


def _questions_after_answers(
    seed: PromptSeed,
    merged_spec: ModelSpec,
    existing_answers: Dict[str, Any],
) -> List[ClarificationQuestion]:
    pending: List[ClarificationQuestion] = []

    if not seed.object_explicit and "object_class" not in existing_answers:
        pending.append(
            ClarificationQuestion(
                id="object_class",
                label="What kind of item are you making?",
                inputType="select",
                options=["earring", "pendant", "ring", "fidget_token", "fidget_spinner"],
            )
        )

    if not seed.shape_explicit and "shape" not in existing_answers:
        pending.append(
            ClarificationQuestion(
                id="shape",
                label="Which shape should we use?",
                inputType="select",
                options=["heart", "circle", "star", "rounded_square"],
            )
        )

    critical = ["thickness"]
    if merged_spec.objectClass != "ring":
        critical.extend(["width", "height"])
    if merged_spec.objectClass in {"earring", "pendant", "fidget_spinner"}:
        critical.append("hole_diameter")

    for field in critical:
        if field not in merged_spec.dimensionsMm:
            pending.append(
                ClarificationQuestion(
                    id=field,
                    label=f"Please provide {field.replace('_', ' ')}.",
                    inputType="number",
                    unit="mm",
                )
            )

    return pending[:4]


async def orchestrate_prompt(
    prompt: str,
    max_dimensions_mm: float,
    existing_spec: Optional[ModelSpec] = None,
    existing_answers: Optional[Dict[str, Any]] = None,
) -> OrchestrationResult:
    seed = parse_prompt(prompt)
    answers = existing_answers or {}

    intent_task = asyncio.create_task(_intent_agent(prompt, seed))
    geometry_task = asyncio.create_task(_geometry_agent(prompt, seed))
    manufacturability_task = asyncio.create_task(_manufacturability_agent(prompt, seed))
    question_task = asyncio.create_task(_question_agent(prompt, seed))
    slicing_task = asyncio.create_task(_slicing_agent(prompt, seed))
    safety_task = asyncio.create_task(_safety_agent(prompt, seed))

    (
        intent_result,
        geometry_result,
        _manufacturability_result,
        question_result,
        slicing_result,
        safety_result,
    ) = await asyncio.gather(
        intent_task,
        geometry_task,
        manufacturability_task,
        question_task,
        slicing_task,
        safety_task,
    )

    base_spec = ModelSpec(
        objectClass=intent_result["objectClass"],
        shape=geometry_result["shape"],
        dimensionsMm=geometry_result["dimensionsMm"],
        featureFlags=geometry_result["featureFlags"],
        printerProfile=slicing_result["printerProfile"],
    )

    if existing_spec is not None:
        base_spec = existing_spec

    merged_spec = _apply_answers(base_spec, answers)

    constrained_spec, adjustments = apply_printability_constraints(
        merged_spec,
        max_dimensions_mm=max_dimensions_mm,
    )

    generated_questions: List[ClarificationQuestion] = question_result["questions"]
    pending_questions = _questions_after_answers(seed, constrained_spec, answers)
    questions = pending_questions if existing_answers else generated_questions

    if safety_result.get("confidence", 1.0) < 0.6 and not any(
        q.id == "thickness" for q in questions
    ):
        questions = [
            ClarificationQuestion(
                id="thickness",
                label="Please confirm the thickness to avoid fragile prints.",
                inputType="number",
                unit="mm",
            ),
            *questions,
        ][:4]

    summary = _build_summary(constrained_spec, questions)
    return OrchestrationResult(
        summary=summary,
        spec=constrained_spec,
        questions=questions,
        adjustments=adjustments,
    )
