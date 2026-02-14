"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  BuildResult,
  ClarificationQuestion,
  PrinterProfile,
  SessionState
} from "@stl-maker/contracts";
import {
  createBuild,
  createSession,
  getArtifacts,
  getBuild,
  patchSpec,
  submitAnswers,
  type BuildStatusResponse
} from "../lib/api";
import { locale } from "../lib/locales/en-GB";

type Step = "create" | "questions" | "refine" | "build" | "results";

const PRINTER_OPTIONS: PrinterProfile[] = ["A1_PLA_0.4", "P1_PLA_0.4", "X1_PLA_0.4"];

function deriveStep(session: SessionState): Step {
  if (session.status === "questions_ready") {
    return "questions";
  }
  if (session.status === "ready_to_build") {
    return "refine";
  }
  if (session.status === "building") {
    return "build";
  }
  if (session.status === "completed") {
    return "results";
  }
  return "create";
}

function normaliseAnswer(question: ClarificationQuestion, value: string): number | string {
  if (question.inputType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

export default function HomePage() {
  const [step, setStep] = useState<Step>("create");
  const [prompt, setPrompt] = useState(
    "I want a 2mm deep earring, in the shape of a heart."
  );
  const [session, setSession] = useState<SessionState | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [dimensionDraft, setDimensionDraft] = useState<Record<string, number>>({});
  const [printerProfile, setPrinterProfile] = useState<PrinterProfile>("A1_PLA_0.4");
  const [build, setBuild] = useState<BuildStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dimensions = useMemo(
    () => session?.modelSpec?.dimensionsMm ?? {},
    [session?.modelSpec?.dimensionsMm]
  );

  useEffect(() => {
    if (!session?.modelSpec?.dimensionsMm) {
      return;
    }
    setDimensionDraft(session.modelSpec.dimensionsMm);
  }, [session?.modelSpec?.dimensionsMm]);

  useEffect(() => {
    if (!build || !["queued", "running"].includes(build.status)) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const updated = await getBuild(build.jobId);
        setBuild(updated);
        if (updated.status === "completed") {
          const artefacts = await getArtifacts(build.jobId);
          setBuild(artefacts);
          setStep("results");
          clearInterval(interval);
        }
        if (updated.status === "failed") {
          setError(updated.error ?? locale.statusFailed);
          clearInterval(interval);
        }
      } catch (pollError) {
        setError((pollError as Error).message);
        clearInterval(interval);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [build]);

  const handleCreate = async () => {
    setError(null);
    setLoading(true);
    try {
      const created = await createSession({ prompt });
      setSession(created);
      setStep(deriveStep(created));
      if (created.modelSpec) {
        setPrinterProfile(created.modelSpec.printerProfile);
      }
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitQuestions = async () => {
    if (!session) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const answers: Record<string, string | number> = {};
      session.questions.forEach((question) => {
        const raw = questionAnswers[question.id] ?? "";
        answers[question.id] = normaliseAnswer(question, raw);
      });

      const updated = await submitAnswers(session.sessionId, answers);
      setSession(updated);
      setStep(deriveStep(updated));
    } catch (answerError) {
      setError((answerError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleApplyRefinement = async () => {
    if (!session) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const updated = await patchSpec(session.sessionId, dimensionDraft);
      setSession(updated);
      setStep("build");
    } catch (patchError) {
      setError((patchError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleBuild = async () => {
    if (!session) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const created = await createBuild({
        sessionId: session.sessionId,
        printerProfile
      });
      setBuild(created);
      setStep("build");
    } catch (buildError) {
      setError((buildError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const resetAll = () => {
    setStep("create");
    setSession(null);
    setQuestionAnswers({});
    setDimensionDraft({});
    setBuild(null);
    setError(null);
  };

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="kicker">en-GB</p>
        <h1>{locale.appTitle}</h1>
        <p>{locale.strapline}</p>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      {step === "create" ? (
        <section className="panel">
          <h2>{locale.createHeading}</h2>
          <label htmlFor="prompt">{locale.createPromptLabel}</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={locale.createPromptPlaceholder}
            rows={5}
          />
          <button onClick={handleCreate} disabled={loading || !prompt.trim()}>
            {loading ? "Preparing…" : locale.submitPrompt}
          </button>
        </section>
      ) : null}

      {step === "questions" && session ? (
        <section className="panel">
          <h2>{locale.questionsHeading}</h2>
          <p>{session.summary}</p>
          {session.questions.map((question) => (
            <div className="question-row" key={question.id}>
              <label htmlFor={question.id}>{question.label}</label>
              {question.inputType === "select" ? (
                <select
                  id={question.id}
                  value={questionAnswers[question.id] ?? ""}
                  onChange={(event) =>
                    setQuestionAnswers((prev) => ({
                      ...prev,
                      [question.id]: event.target.value
                    }))
                  }
                >
                  <option value="">Select an option</option>
                  {question.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={question.id}
                  type={question.inputType === "number" ? "number" : "text"}
                  value={questionAnswers[question.id] ?? ""}
                  onChange={(event) =>
                    setQuestionAnswers((prev) => ({
                      ...prev,
                      [question.id]: event.target.value
                    }))
                  }
                  placeholder={question.unit ?? "Provide details"}
                />
              )}
            </div>
          ))}
          <button onClick={handleSubmitQuestions} disabled={loading}>
            {loading ? "Analysing…" : locale.submitQuestions}
          </button>
        </section>
      ) : null}

      {step === "refine" && session ? (
        <section className="panel">
          <h2>{locale.refineHeading}</h2>
          <p>{session.summary}</p>

          {Object.entries(dimensions).map(([key, value]) => (
            <div className="question-row" key={key}>
              <label htmlFor={key}>{key} (mm)</label>
              <input
                id={key}
                type="range"
                min={0.6}
                max={80}
                step={0.1}
                value={dimensionDraft[key] ?? value}
                onChange={(event) =>
                  setDimensionDraft((prev) => ({
                    ...prev,
                    [key]: Number(event.target.value)
                  }))
                }
              />
              <input
                type="number"
                min={0.6}
                max={80}
                step={0.1}
                value={dimensionDraft[key] ?? value}
                onChange={(event) =>
                  setDimensionDraft((prev) => ({
                    ...prev,
                    [key]: Number(event.target.value)
                  }))
                }
              />
            </div>
          ))}

          <div className="question-row">
            <label htmlFor="printer-profile">Printer profile</label>
            <select
              id="printer-profile"
              value={printerProfile}
              onChange={(event) => setPrinterProfile(event.target.value as PrinterProfile)}
            >
              {PRINTER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <button onClick={handleApplyRefinement} disabled={loading}>
            {loading ? "Applying…" : locale.applyRefinement}
          </button>
        </section>
      ) : null}

      {step === "build" ? (
        <section className="panel">
          <h2>{locale.buildHeading}</h2>
          {!build ? <p>{locale.statusReady}</p> : null}
          {!build ? (
            <button onClick={handleBuild} disabled={loading}>
              {loading ? "Starting…" : locale.startBuild}
            </button>
          ) : null}

          {build ? (
            <div className="progress-stack">
              <p>
                {locale.progress}: <strong>{build.stage ?? "Understanding request"}</strong>
              </p>
              <p>
                Status: <strong>{build.status}</strong>
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {step === "results" && session && build ? (
        <section className="panel">
          <h2>{locale.resultsHeading}</h2>
          <p>{session.summary}</p>

          {session.adjustments.length > 0 ? (
            <div>
              <h3>{locale.autoAdjustments}</h3>
              <ul>
                {session.adjustments.map((adjustment, index) => (
                  <li key={`${adjustment.field}-${index}`}>
                    {adjustment.field}: {String(adjustment.from)} {"->"} {String(adjustment.to)} ({adjustment.reason})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="result-links">
            {build.stlUrl ? (
              <a href={build.stlUrl} target="_blank" rel="noreferrer">
                Download STL
              </a>
            ) : null}
            {build.project3mfUrl ? (
              <a href={build.project3mfUrl} target="_blank" rel="noreferrer">
                Download 3MF
              </a>
            ) : null}
            {build.reportUrl ? (
              <a href={build.reportUrl} target="_blank" rel="noreferrer">
                View slicing summary
              </a>
            ) : null}
          </div>

          <p className="retention-note">{locale.retentionNotice}</p>
          <button onClick={resetAll}>{locale.backToStart}</button>
        </section>
      ) : null}
    </main>
  );
}
