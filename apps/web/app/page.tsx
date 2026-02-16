"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ClarificationQuestion,
  GenerateResponse,
  InterpretResponse,
  ModelSpec,
  PrinterProfile
} from "@stl-maker/contracts";
import { STAGE_LABELS } from "@stl-maker/contracts";
import { generate, interpret } from "../lib/api";
import { locale } from "../lib/locales/en-GB";

type Step = "create" | "questions" | "refine" | "build" | "results";

const PRINTER_OPTIONS: PrinterProfile[] = ["A1_PLA_0.4", "P1_PLA_0.4", "X1_PLA_0.4"];

function normaliseAnswer(question: ClarificationQuestion, value: string): number | string {
  if (question.inputType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function withDraftSpec(
  interpreted: InterpretResponse,
  dimensionDraft: Record<string, number>,
  printerProfile: PrinterProfile
): ModelSpec {
  return {
    ...interpreted.modelSpec,
    printerProfile,
    dimensionsMm: {
      ...interpreted.modelSpec.dimensionsMm,
      ...dimensionDraft
    }
  };
}

export default function HomePage() {
  const [step, setStep] = useState<Step>("create");
  const [prompt, setPrompt] = useState("I want a 2mm deep earring, in the shape of a heart.");
  const [interpreted, setInterpreted] = useState<InterpretResponse | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [resolvedAnswers, setResolvedAnswers] = useState<Record<string, string | number>>({});
  const [dimensionDraft, setDimensionDraft] = useState<Record<string, number>>({});
  const [printerProfile, setPrinterProfile] = useState<PrinterProfile>("A1_PLA_0.4");
  const [generated, setGenerated] = useState<GenerateResponse | null>(null);
  const [stlUrl, setStlUrl] = useState<string | null>(null);
  const [guideUrl, setGuideUrl] = useState<string | null>(null);
  const [progressIndex, setProgressIndex] = useState(0);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const progressTimerRef = useRef<number | null>(null);

  const dimensions = useMemo(
    () => interpreted?.modelSpec?.dimensionsMm ?? {},
    [interpreted?.modelSpec?.dimensionsMm]
  );

  useEffect(() => {
    if (!interpreted) {
      return;
    }

    setDimensionDraft(interpreted.modelSpec.dimensionsMm);
    setPrinterProfile(interpreted.modelSpec.printerProfile);
  }, [interpreted]);

  useEffect(() => {
    return () => {
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
      if (stlUrl) {
        URL.revokeObjectURL(stlUrl);
      }
      if (guideUrl) {
        URL.revokeObjectURL(guideUrl);
      }
    };
  }, [guideUrl, stlUrl]);

  const handleCreate = async () => {
    setError(null);
    setIsWorking(true);
    setGenerated(null);
    try {
      const response = await interpret({ prompt });
      setInterpreted(response);
      setQuestionAnswers({});
      setResolvedAnswers({});
      setStep(response.questions.length > 0 ? "questions" : "refine");
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setIsWorking(false);
    }
  };

  const handleSubmitQuestions = async () => {
    if (!interpreted) {
      return;
    }

    setError(null);
    setIsWorking(true);

    try {
      const answers: Record<string, string | number> = {};
      interpreted.questions.forEach((question) => {
        const raw = questionAnswers[question.id] ?? "";
        answers[question.id] = normaliseAnswer(question, raw);
      });

      const mergedAnswers = {
        ...resolvedAnswers,
        ...answers
      };

      const response = await interpret({
        prompt,
        answers: mergedAnswers,
        draftSpec: withDraftSpec(interpreted, dimensionDraft, printerProfile)
      });

      setResolvedAnswers(mergedAnswers);
      setQuestionAnswers({});
      setInterpreted(response);
      setStep(response.questions.length > 0 ? "questions" : "refine");
    } catch (questionError) {
      setError((questionError as Error).message);
    } finally {
      setIsWorking(false);
    }
  };

  const handleRefineContinue = () => {
    if (!interpreted) {
      return;
    }

    setInterpreted({
      ...interpreted,
      modelSpec: withDraftSpec(interpreted, dimensionDraft, printerProfile)
    });
    setStep("build");
  };

  const handleGenerate = async () => {
    if (!interpreted) {
      return;
    }

    setError(null);
    setIsWorking(true);
    setProgressIndex(0);

    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
    }

    progressTimerRef.current = window.setInterval(() => {
      setProgressIndex((prev) => Math.min(prev + 1, STAGE_LABELS.length - 1));
    }, 850);

    try {
      const finalSpec = withDraftSpec(interpreted, dimensionDraft, printerProfile);
      const response = await generate({
        modelSpec: finalSpec,
        printerProfile
      });

      if (stlUrl) {
        URL.revokeObjectURL(stlUrl);
      }
      if (guideUrl) {
        URL.revokeObjectURL(guideUrl);
      }

      const stlBlob = new Blob([base64ToArrayBuffer(response.stlBase64)], {
        type: "model/stl"
      });

      const guideBlob = new Blob([JSON.stringify(response.slicingGuide, null, 2)], {
        type: "application/json"
      });

      setStlUrl(URL.createObjectURL(stlBlob));
      setGuideUrl(URL.createObjectURL(guideBlob));
      setGenerated(response);
      setStep("results");
    } catch (generateError) {
      setError((generateError as Error).message);
    } finally {
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
      setIsWorking(false);
    }
  };

  const resetAll = () => {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
    }
    if (stlUrl) {
      URL.revokeObjectURL(stlUrl);
    }
    if (guideUrl) {
      URL.revokeObjectURL(guideUrl);
    }

    setStep("create");
    setInterpreted(null);
    setQuestionAnswers({});
    setResolvedAnswers({});
    setDimensionDraft({});
    setPrinterProfile("A1_PLA_0.4");
    setGenerated(null);
    setStlUrl(null);
    setGuideUrl(null);
    setError(null);
    setProgressIndex(0);
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
          <button onClick={handleCreate} disabled={isWorking || !prompt.trim()}>
            {isWorking ? "Preparing…" : locale.submitPrompt}
          </button>
        </section>
      ) : null}

      {step === "questions" && interpreted ? (
        <section className="panel">
          <h2>{locale.questionsHeading}</h2>
          <p>{interpreted.summary}</p>
          {interpreted.questions.map((question) => (
            <div className="question-row" key={question.id}>
              <label htmlFor={question.id}>{question.label}</label>
              {question.inputType === "select" ? (
                <select
                  id={question.id}
                  value={questionAnswers[question.id] ?? ""}
                  onChange={(event) =>
                    setQuestionAnswers((previous) => ({
                      ...previous,
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
                    setQuestionAnswers((previous) => ({
                      ...previous,
                      [question.id]: event.target.value
                    }))
                  }
                  placeholder={question.unit ?? "Provide details"}
                />
              )}
            </div>
          ))}
          <button onClick={handleSubmitQuestions} disabled={isWorking}>
            {isWorking ? "Analysing…" : locale.submitQuestions}
          </button>
        </section>
      ) : null}

      {step === "refine" && interpreted ? (
        <section className="panel">
          <h2>{locale.refineHeading}</h2>
          <p>{interpreted.summary}</p>

          {Object.entries(dimensions).map(([key, value]) => (
            <div className="question-row" key={key}>
              <label htmlFor={key}>{key} (mm)</label>
              <input
                id={key}
                type="range"
                min={0.6}
                max={120}
                step={0.1}
                value={dimensionDraft[key] ?? value}
                onChange={(event) =>
                  setDimensionDraft((previous) => ({
                    ...previous,
                    [key]: Number(event.target.value)
                  }))
                }
              />
              <input
                type="number"
                min={0.6}
                max={120}
                step={0.1}
                value={dimensionDraft[key] ?? value}
                onChange={(event) =>
                  setDimensionDraft((previous) => ({
                    ...previous,
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

          <button onClick={handleRefineContinue} disabled={isWorking}>
            {locale.applyRefinement}
          </button>
        </section>
      ) : null}

      {step === "build" && interpreted ? (
        <section className="panel">
          <h2>{locale.buildHeading}</h2>
          <p>{interpreted.summary}</p>
          <p>
            {locale.progress}: <strong>{STAGE_LABELS[progressIndex]}</strong>
          </p>
          <p>
            Profile: <strong>{printerProfile}</strong>
          </p>
          <button onClick={handleGenerate} disabled={isWorking}>
            {isWorking ? "Generating…" : locale.startBuild}
          </button>
        </section>
      ) : null}

      {step === "results" && interpreted && generated ? (
        <section className="panel">
          <h2>{locale.resultsHeading}</h2>
          <p>{interpreted.summary}</p>

          {interpreted.adjustments.length > 0 ? (
            <div>
              <h3>{locale.autoAdjustments}</h3>
              <ul>
                {interpreted.adjustments.map((adjustment, index) => (
                  <li key={`${adjustment.field}-${index}`}>
                    {adjustment.field}: {String(adjustment.from)} {"->"} {String(adjustment.to)} ({adjustment.reason})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="result-links">
            {stlUrl ? (
              <a href={stlUrl} download={generated.stlFileName}>
                Download STL
              </a>
            ) : null}
            {guideUrl ? (
              <a
                href={guideUrl}
                download={generated.stlFileName.replace(/\.stl$/i, "") + "-slicing-guide.json"}
              >
                Download slicing guide JSON
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
