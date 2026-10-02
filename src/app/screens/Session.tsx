import { useCallback, useEffect, useState } from "react";
import type { AttemptView, Choice, QuestionView, SessionView } from "../../server/api-types";
import { getJson, postJson } from "../api";
import { Layout, Notice } from "../components/Layout";
import { SectionPanel } from "../components/SectionPanel";
import { StatusMark } from "../components/StatusMark";
import { href } from "../router";

export function Session({ id }: { id: number }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getJson<SessionView>(`/api/sessions/${id}`)
      .then((data) => {
        setSession(data);
        setError(null);
      })
      .catch((problem: unknown) => setError((problem as Error).message));
  }, [id]);

  useEffect(load, [load]);

  // While the model writes the questions, ask the server for the progress.
  useEffect(() => {
    if (session?.status !== "preparing") return;
    const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
  }, [session?.status, load]);

  const crumbs = session
    ? [
        { label: "Themes", href: href.home() },
        { label: session.theme.name, href: href.theme(session.theme.slug) },
        { label: "Concept map", href: href.map(session.theme.slug) },
        { label: "Diagnosis" },
      ]
    : [{ label: "Themes", href: href.home() }];

  return (
    <Layout crumbs={crumbs}>
      {!session && !error && <p className="quiet">Loading the diagnosis.</p>}
      {error && !session && <Notice title="The diagnosis did not load">{<p>{error}</p>}</Notice>}
      {session && <SessionBody session={session} onChange={setSession} />}
    </Layout>
  );
}

function SessionBody({ session, onChange }: { session: SessionView; onChange: (session: SessionView) => void }) {
  const title = session.module ? `Diagnosis: ${session.module.name}` : "Diagnosis";
  if (session.status === "preparing") {
    return (
      <>
        <h1>{title}</h1>
        <p className="lead" role="status">
          The tutor writes the questions: {session.prepared} of {session.total} concepts are ready.
        </p>
        <div className="progress-bar" aria-hidden="true">
          <span className="segment segment-mastered" style={{ flexGrow: session.prepared }} />
          <span className="segment segment-new" style={{ flexGrow: Math.max(0, session.total - session.prepared) || 0.0001 }} />
        </div>
      </>
    );
  }
  if (session.status === "failed") return <FailedView session={session} title={title} onChange={onChange} />;
  if (session.status === "finished") return <ResultsView session={session} />;
  return <QuestionFlow session={session} title={title} onChange={onChange} />;
}

function FailedView({ session, title, onChange }: { session: SessionView; title: string; onChange: (session: SessionView) => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setSending(true);
    try {
      onChange(await postJson<SessionView>(`/api/sessions/${session.id}/prepare`));
    } catch (problem) {
      setError((problem as Error).message);
      setSending(false);
    }
  };
  return (
    <>
      <h1>{title}</h1>
      <p>The tutor could not write the questions.</p>
      <p className="error">{session.error}</p>
      <button className="button" onClick={retry} disabled={sending}>
        {sending ? "Starting" : "Try again"}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function QuestionFlow({ session, title, onChange }: { session: SessionView; title: string; onChange: (session: SessionView) => void }) {
  const firstOpen = session.questions.findIndex((question) => question.attempt === null);
  const [index, setIndex] = useState(firstOpen === -1 ? session.questions.length - 1 : firstOpen);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = session.questions[index];
  if (!question) return <Notice title="This diagnosis has no questions" />;

  const updateAttempt = (attempt: AttemptView) =>
    onChange({
      ...session,
      questions: session.questions.map((item) => (item.id === question.id ? { ...item, attempt } : item)),
    });

  const finish = async () => {
    setFinishing(true);
    try {
      onChange(await postJson<SessionView>(`/api/sessions/${session.id}/finish`));
    } catch (problem) {
      setError((problem as Error).message);
      setFinishing(false);
    }
  };

  const last = index === session.questions.length - 1;
  const answered = session.questions.filter((item) => item.attempt !== null).length;
  return (
    <>
      <h1>{title}</h1>
      <p className="lead">
        Question {index + 1} of {session.questions.length}. Answer from what you know now. A wrong answer only puts the concept in
        your study queue.
      </p>
      <QuestionCard key={question.id} question={question} onAnswered={updateAttempt} />
      <div className="action-bar">
        <span className="quiet">
          {answered} of {session.questions.length} answered
        </span>
        <span className="action-group">
          {index > 0 && (
            <button className="text-button" onClick={() => setIndex(index - 1)}>
              Previous question
            </button>
          )}
          {!last && (
            <button className="button" onClick={() => setIndex(index + 1)} disabled={question.attempt === null}>
              Next question
            </button>
          )}
          {last && (
            <button className="button" onClick={finish} disabled={finishing}>
              {finishing ? "Saving" : "See the results"}
            </button>
          )}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

const VERDICT: Record<number, string> = { 2: "Correct", 1: "Partly correct", 0: "Not correct" };

function QuestionCard({ question, onAnswered }: { question: QuestionView; onAnswered: (attempt: AttemptView) => void }) {
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const attempt = question.attempt;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const answer = question.kind === "choice" ? String(choice) : text;
      onAnswered(await postJson<AttemptView>(`/api/questions/${question.id}/answer`, { answer }));
    } catch (problem) {
      setError((problem as Error).message);
    }
    setSending(false);
  };

  const dispute = async () => {
    if (!attempt) return;
    try {
      onAnswered(await postJson<AttemptView>(`/api/attempts/${attempt.id}/dispute`));
    } catch (problem) {
      setError((problem as Error).message);
    }
  };

  return (
    <article className="question">
      {attempt && (
        <div className="margin" aria-hidden="true">
          <span className={`mark ${attempt.correct ? "mark-known" : "mark-failed"}`}>{attempt.correct ? "✓" : "✗"}</span>
        </div>
      )}
      <p className="question-about">About: {question.conceptName}</p>
      <p className="question-text">{question.text}</p>

      {question.kind === "choice" && question.choices && (
        <fieldset className="options" disabled={attempt !== null}>
          <legend className="visually-hidden">Options</legend>
          {question.choices.map((option, i) => {
            const picked = attempt ? Number(attempt.answer) === i : choice === i;
            const state = attempt ? (i === attempt.correctIndex ? "right" : picked ? "wrong" : "") : picked ? "picked" : "";
            return (
              <label key={i} className={`option ${state}`}>
                <input type="radio" name={`question-${question.id}`} checked={picked} onChange={() => setChoice(i)} />
                <span>{option}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      {question.kind !== "choice" && (
        <div className="open-answer">
          <label htmlFor={`answer-${question.id}`}>Your answer</label>
          <textarea
            id={`answer-${question.id}`}
            value={attempt ? attempt.answer : text}
            onChange={(event) => setText(event.target.value)}
            readOnly={attempt !== null}
            rows={question.kind === "apply" ? 7 : 4}
          />
        </div>
      )}

      {!attempt && (
        <p>
          <button
            className="button"
            onClick={send}
            disabled={sending || (question.kind === "choice" ? choice === null : text.trim() === "")}
          >
            {sending ? (question.kind === "choice" ? "Checking" : "Grading") : "Check the answer"}
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {attempt && (
        <div className="feedback" role="status">
          {question.kind === "choice" ? (
            <>
              <p className="verdict">{attempt.correct ? "Correct" : "Not correct"}</p>
              {attempt.keyPoints[0] && <p>{attempt.keyPoints[0]}</p>}
            </>
          ) : (
            <>
              <p className="verdict">{attempt.disputed ? "Counted as correct" : VERDICT[attempt.score]}</p>
              {attempt.feedback && <p>{attempt.feedback}</p>}
              {attempt.keyPoints.length > 0 && (
                <>
                  <p className="feedback-label">A good answer has these points:</p>
                  <ul>
                    {attempt.keyPoints.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </>
              )}
              {attempt.modelAnswer && (
                <p>
                  <span className="feedback-label">Model answer: </span>
                  {attempt.modelAnswer}
                </p>
              )}
              {!attempt.correct && (
                <p>
                  <button className="text-button" onClick={dispute}>
                    Dispute the grade
                  </button>{" "}
                  <span className="quiet">if your answer is correct. A disputed answer counts as correct.</span>
                </p>
              )}
            </>
          )}
          {question.source && (
            <p>
              <button className="text-button" onClick={() => setPanel(true)}>
                Read the section
              </button>{" "}
              <span className="quiet">
                {question.source.ref} {question.source.title}
                {question.source.page ? `, page ${question.source.page}` : ""}
              </span>
            </p>
          )}
        </div>
      )}
      {panel && question.source && <SectionPanel sectionId={question.source.sectionId} onClose={() => setPanel(false)} />}
    </article>
  );
}

function ResultsView({ session }: { session: SessionView }) {
  const results = session.results ?? [];
  const [choices, setChoices] = useState<Record<number, Choice>>(() =>
    Object.fromEntries(results.map((result) => [result.conceptId, result.result === "failed" ? "learn" : "keep"])),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = results.filter((result) => result.result === "known").length;
  const tested = results.filter((result) => result.result !== "none").length;

  const save = async () => {
    setSending(true);
    try {
      // A concept that the learner already moved to the queue or skipped needs no choice now.
      const pending = Object.fromEntries(
        Object.entries(choices).filter(([id]) => {
          const result = results.find((item) => item.conceptId === Number(id));
          return result && (result.status === "known" || result.status === "failed");
        }),
      );
      await postJson(`/api/sessions/${session.id}/choices`, { choices: pending });
      window.location.hash = href.map(session.theme.slug);
    } catch (problem) {
      setError((problem as Error).message);
      setSending(false);
    }
  };

  const set = (id: number, choice: Choice) => setChoices((current) => ({ ...current, [id]: choice }));
  return (
    <>
      <h1>Results</h1>
      <p className="lead">
        You know {known} of {tested} tested concepts. Choose what to learn. The concepts that you choose go to your study queue.
      </p>
      <ul className="concepts">
        {results.map((result) => (
          <li key={result.conceptId} className="concept concept-select">
            <div className="margin">
              <StatusMark status={result.result === "known" ? "known" : result.result === "failed" ? "failed" : "new"} />
            </div>
            <div className="concept-body">
              <div className="concept-head">
                <span className="concept-title">{result.name}</span>
                <span className="concept-meta">
                  {result.result === "known" ? "You know it" : result.result === "failed" ? "To learn" : "No questions"}
                </span>
              </div>
              {result.wrong.map((wrong) => (
                <div key={wrong.question} className="wrong">
                  <p className="wrong-question">{wrong.question}</p>
                  <p className="quiet">
                    Your answer: {wrong.answer}
                    {wrong.feedback && wrong.feedback !== "Not correct." ? ` ${wrong.feedback}` : ""}
                  </p>
                </div>
              ))}
              {result.result === "none" && <p className="quiet">The model wrote no usable questions. The concept stays not started.</p>}
            </div>
            {result.result === "failed" && (
              <div className="segmented" role="radiogroup" aria-label={`Choice for ${result.name}`}>
                {(["learn", "skip"] as const).map((value) => (
                  <label key={value} className={choices[result.conceptId] === value ? "selected" : ""}>
                    <input
                      type="radio"
                      name={`choice-${result.conceptId}`}
                      checked={choices[result.conceptId] === value}
                      onChange={() => set(result.conceptId, value)}
                    />
                    {value === "learn" ? "Learn" : "Skip"}
                  </label>
                ))}
              </div>
            )}
            {result.result === "known" && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={choices[result.conceptId] === "learn"}
                  onChange={(event) => set(result.conceptId, event.target.checked ? "learn" : "keep")}
                />
                Learn it anyway
              </label>
            )}
          </li>
        ))}
      </ul>
      <div className="action-bar">
        <span className="quiet">{Object.values(choices).filter((choice) => choice === "learn").length} to learn</span>
        <button className="button" onClick={save} disabled={sending}>
          {sending ? "Saving" : "Save and open the concept map"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}
