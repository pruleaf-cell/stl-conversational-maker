from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.main import app, store

client = TestClient(app)


def setup_function() -> None:
    store.clear()


def test_prompt_parsing_earring_heart() -> None:
    response = client.post(
        "/api/v1/sessions",
        json={"prompt": "I want a 2mm deep earring, in the shape of a heart."},
    )
    assert response.status_code == 200

    payload = response.json()
    assert payload["modelSpec"]["objectClass"] == "earring"
    assert payload["modelSpec"]["shape"] == "heart"
    assert payload["modelSpec"]["dimensionsMm"]["thickness"] >= 1.8


def test_question_count_capped_at_four() -> None:
    response = client.post("/api/v1/sessions", json={"prompt": "Make me something cute."})
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["questions"]) <= 4
    assert "optimised" in payload["summary"].lower()


def test_auto_adjust_thickness() -> None:
    response = client.post(
        "/api/v1/sessions",
        json={"prompt": "I want a 0.4mm deep pendant in a circle."},
    )
    assert response.status_code == 200
    payload = response.json()

    assert payload["modelSpec"]["dimensionsMm"]["thickness"] >= 2.0
    assert any(adjustment["field"] == "thickness" for adjustment in payload["adjustments"])


def test_build_creates_artifacts_urls() -> None:
    session_response = client.post(
        "/api/v1/sessions",
        json={
            "prompt": (
                "I want an earring in a heart shape, width 20mm, height 22mm, "
                "thickness 2mm, hole diameter 2mm"
            )
        },
    )
    assert session_response.status_code == 200
    session = session_response.json()
    assert session["status"] in {"ready_to_build", "questions_ready"}

    if session["status"] == "questions_ready":
        answers = {
            item["id"]: 2 if item["id"] in {"thickness", "hole_diameter"} else 20
            for item in session["questions"]
        }
        answered = client.post(
            f"/api/v1/sessions/{session['sessionId']}/answers",
            json={"answers": answers},
        )
        assert answered.status_code == 200
        session = answered.json()

    build_response = client.post(
        "/api/v1/builds",
        json={"sessionId": session["sessionId"], "printerProfile": "A1_PLA_0.4"},
    )
    assert build_response.status_code == 200
    job_id = build_response.json()["jobId"]

    deadline = time.time() + 10
    status_payload = None
    while time.time() < deadline:
        poll = client.get(f"/api/v1/builds/{job_id}")
        assert poll.status_code == 200
        status_payload = poll.json()
        if status_payload["status"] in {"completed", "failed"}:
            break
        time.sleep(0.25)

    assert status_payload is not None
    assert status_payload["status"] == "completed"
    assert status_payload["stlUrl"]
    assert status_payload["reportUrl"]
