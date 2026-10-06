import { useCallback, useEffect, useState } from "react";
import type { AfterTestAction, AttemptView, Choice, QuestionView, SessionView } from "../../server/api-types";
import { getJson, postJson } from "../api";
import { Layout, Notice } from "../components/Layout";
import { SectionPanel } from "../components/SectionPanel";
import { Spinner } from "../components/Spinner";
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

  // A test after a lesson belongs to the study queue. A diagnosis starts on the concept map, so it belongs to the map.
  return (
    <Layout theme={session?.theme} tab={session?.kind === "test" ? "queue" : "map"}>
      {session?.kind === "test" && session.concept && (
        <p className="back-link">
          <a href={href.lesson(session.concept.id)}>Back to the lesson: {session.concept.name}</a>
        </p>
      )}
      {!session && !error && <p className="quiet">Loading the questions.</p>}
      {error && !session && <Notice title="The questions did not load">{<p>{error}</p>}</Notice>}
      {session && <SessionBody session={session} onChange={setSession} />}
    </Layout>
  );
}

function SessionBody({ session, onChange }: { session: SessionView; onChange: (session: SessionView) => void }) {
  const test = session.kind === "test";
  const title = test && session.concept ? `Test: ${session.concept.name}` : session.module ? `Diagnosis: ${session.module.name}` : "Diagnosis";
  if (session.status === "preparing" && test) {
    return (
      <>
        <h1>{title}</h1>
        <p className="lead" role="status">
          <Spinner />
          The tutor writes new questions about the concept.
        </p>
        <Waiting />
      </>
    );
  }
  if (session.status === "preparing") {
    return (
      <>
        <h1>{title}</h1>
        <p className="lead" role="status">
          <Spinner />
          The tutor writes the questions: {session.prepared} of {session.total} concepts are ready.
        </p>
        <div className="progress-bar" aria-hidden="true">
          <span className="segment segment-mastered" style={{ flexGrow: session.prepared }} />
          <span className="segment segment-new" style={{ flexGrow: Math.max(0, session.total - session.prepared) || 0.0001 }} />
        </div>
        <Waiting />
      </>
    );
  }
  if (session.status === "failed") return <FailedView session={session} title={title} onChange={onChange} />;
  if (session.status === "finished") return test ? <TestResults session={session} /> : <ResultsView session={session} />;
  return <QuestionFlow session={session} title={title} onChange={onChange} />;
}

// The time since the page started to wait for the model.
function Waiting() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const time = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return (
    <p className="quiet">
      Waiting for the model: {time}. The time depends on the model and its reasoning level. A high reasoning level can take some minutes.
    </p>
  );
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

  // The attempt is null after a retake: the question is open again.
  const updateAttempt = (attempt: AttemptView | null) =>
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
        Question {index + 1} of {session.questions.length}.{" "}
        {session.kind === "test"
          ? "To pass the test, answer each question correctly."
          : "Answer from what you know now. A wrong answer only puts the concept in your study queue."}
      </p>
      <QuestionCard
        key={question.id}
        question={question}
        about={session.kind === "test" ? TEST_LABEL[question.kind] : `About: ${question.conceptName}`}
        onAnswered={updateAttempt}
      />
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

const TEST_LABEL: Record<QuestionView["kind"], string> = {
  choice: "Recall question",
  short: "Explain question",
  apply: "Apply question",
};

function QuestionCard({
  question,
  about,
  onAnswered,
}: {
  question: QuestionView;
  about: string;
  onAnswered: (attempt: AttemptView | null) => void;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [retaking, setRetaking] = useState(false);
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

  // Remove the answer, and show the empty question again.
  const retake = async () => {
    setRetaking(true);
    setError(null);
    try {
      await postJson(`/api/questions/${question.id}/retake`);
      setChoice(null);
      setText("");
      onAnswered(null);
    } catch (problem) {
      setError((problem as Error).message);
    }
    setRetaking(false);
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
      <p className="question-about">{about}</p>
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
            {sending ? (
              <>
                <Spinner />
                {question.kind === "choice" ? "Checking" : "Grading"}
              </>
            ) : (
              "Check the answer"
            )}
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
          <p>
            <button className="button secondary small" onClick={retake} disabled={retaking}>
              Retake the question
            </button>
          </p>
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

// The result of a test after a lesson. A pass makes the concept mastered. After a fail, the learner
// chooses: teach it again, keep it for later, or skip it. After 3 fails, the tutor offers to test the prerequisites.
function TestResults({ session }: { session: SessionView }) {
  const outcome = session.outcome!;
  const concept = session.concept!;
  const wrong = session.results?.[0]?.wrong ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Do the action, then open the page that the action returns.
  const run = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    setError(null);
    try {
      window.location.hash = await action();
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };

  const teachAgain = () =>
    run("again", async () => {
      await postJson(`/api/concepts/${concept.id}/lesson`, { again: true });
      return href.lesson(concept.id);
    });
  const after = (action: AfterTestAction) =>
    run(action, async () => {
      await postJson(`/api/concepts/${concept.id}/after-test`, { action });
      return href.queue(session.theme.slug);
    });
  const testPrerequisites = () =>
    run("prerequisites", async () => {
      const { sessionId } = await postJson<{ sessionId: number }>(`/api/concepts/${concept.id}/test-prerequisites`);
      return href.session(sessionId);
    });

  const score = `${outcome.correct} of ${outcome.total} answers are correct.`;
  const wrongList = wrong.length > 0 && (
    <section aria-labelledby="wrong-heading">
      <h2 id="wrong-heading">Wrong answers</h2>
      {wrong.map((item) => (
        <div key={item.question} className="wrong">
          <p className="wrong-question">{item.question}</p>
          <p className="quiet">
            Your answer: {item.answer}
            {item.feedback && item.feedback !== "Not correct." ? ` ${item.feedback}` : ""}
          </p>
        </div>
      ))}
    </section>
  );

  if (outcome.passed) {
    return (
      <>
        <div className="result-head">
          <div className="margin" aria-hidden="true">
            <StatusMark status="mastered" />
          </div>
          <h1>You passed the test</h1>
        </div>
        <p className="lead">
          {score} {concept.name} is mastered.
        </p>
        {wrongList}
        <p className="button-row">
          {outcome.next ? (
            <a className="button" href={href.lesson(outcome.next.conceptId)}>
              Next lesson: {outcome.next.name}
            </a>
          ) : (
            <span>Your study queue is empty.</span>
          )}
          <a className="text-link" href={outcome.next ? href.queue(session.theme.slug) : href.map(session.theme.slug)}>
            {outcome.next ? "Open the study queue" : "Open the concept map"}
          </a>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="result-head">
        <div className="margin" aria-hidden="true">
          <StatusMark status="failed" />
        </div>
        <h1>You did not pass the test</h1>
      </div>
      <p className="lead">
        {score} To pass, answer each question correctly.
      </p>
      {/* A failed test again of a mastered concept does not change its status. */}
      {session.results?.[0]?.status === "mastered" && (
        <p>{concept.name} stays mastered. To keep it so, leave this page. To learn it again, choose an action below.</p>
      )}
      {wrongList}
      {outcome.failedTests >= 3 && outcome.hasPrerequisites && (
        <div className="suggestion">
          <p>
            You did not pass this test {outcome.failedTests} times. A gap in a prerequisite is a frequent cause. The tutor can test the
            prerequisites of {concept.name}.
          </p>
          <button className="button" onClick={testPrerequisites} disabled={busy !== null}>
            {busy === "prerequisites" ? "Starting" : "Test the prerequisites"}
          </button>
        </div>
      )}
      <h2>What next</h2>
      <ul className="plain-list next-steps">
        <li>
          <button className="text-button strong" onClick={teachAgain} disabled={busy !== null}>
            {busy === "again" ? (
              <>
                <Spinner />
                Writing a new lesson
              </>
            ) : (
              "Teach it again"
            )}
          </button>{" "}
          <span className="quiet">The tutor writes a new lesson from a different angle. Then you take a new test.</span>
        </li>
        <li>
          <button className="text-button" onClick={() => after("later")} disabled={busy !== null}>
            Later
          </button>{" "}
          <span className="quiet">The concept goes to the end of your study queue.</span>
        </li>
        <li>
          <button className="text-button" onClick={() => after("skip")} disabled={busy !== null}>
            Skip
          </button>{" "}
          <span className="quiet">The concept leaves your study queue. You do not learn it.</span>
        </li>
      </ul>
      {busy === "again" && (
        <p className="quiet" role="status">
          The tutor writes the lesson. This can take a minute.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
