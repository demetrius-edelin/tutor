import { useEffect, useRef, useState } from "react";
import type { LessonReference, LessonView } from "../../server/api-types";
import { getJson, postJson } from "../api";
import { CitedMarkdown, ReferenceList } from "../components/CitedMarkdown";
import { Layout, Notice } from "../components/Layout";
import { SectionPanel } from "../components/SectionPanel";
import { Spinner } from "../components/Spinner";
import { StarButton } from "../components/StarButton";
import { STATUS_INFO } from "../components/StatusMark";
import { href } from "../router";

const LEVEL = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" } as const;

export function Lesson({ conceptId }: { conceptId: number }) {
  const [view, setView] = useState<LessonView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<LessonView>(`/api/concepts/${conceptId}/lesson`)
      .then(setView)
      .catch((problem: unknown) => setError((problem as Error).message));
  }, [conceptId]);

  return (
    <Layout theme={view?.concept.theme} tab="queue">
      {!view && !error && <p className="quiet">Loading the lesson.</p>}
      {!view && error && <Notice title="The lesson did not load">{<p>{error}</p>}</Notice>}
      {view && !view.lesson && <LessonStart view={view} onStarted={setView} />}
      {view && view.lesson && <LessonBody view={view} onChange={setView} />}
    </Layout>
  );
}

function ConceptHeader({ view, onChange }: { view: LessonView; onChange: (view: LessonView) => void }) {
  return (
    <>
      <div className="title-row">
        <h1>{view.concept.name}</h1>
        <StarButton
          conceptId={view.concept.id}
          name={view.concept.name}
          starred={view.concept.starred}
          onChange={(starred) => onChange({ ...view, concept: { ...view.concept, starred } })}
        />
      </div>
      <p className="lead">{view.concept.objective}</p>
      <p className="quiet small">
        {LEVEL[view.concept.level]} {view.concept.kind}, module {view.concept.module.position}, {view.concept.module.name}
        {view.lesson && view.lesson.round > 1 ? `. Lesson ${view.lesson.round}` : ""}
      </p>
    </>
  );
}

function LessonStart({ view, onStarted }: { view: LessonView; onStarted: (view: LessonView) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      onStarted(await postJson<LessonView>(`/api/concepts/${view.concept.id}/lesson`));
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };

  const learnFirst = async (conceptId: number) => {
    setBusy("learn");
    try {
      await postJson(`/api/concepts/${conceptId}/top`);
      window.location.hash = href.lesson(conceptId);
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };

  const testIt = async (conceptId: number) => {
    setBusy("test");
    try {
      const { sessionId } = await postJson<{ sessionId: number }>(`/api/concepts/${conceptId}/test`);
      window.location.hash = href.session(sessionId);
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };

  return (
    <>
      <ConceptHeader view={view} onChange={onStarted} />
      {view.missingPrerequisites.length > 0 && (
        <div className="suggestion">
          <p>{view.warning}</p>
          {view.missingPrerequisites.map((prerequisite) => (
            <p key={prerequisite.conceptId} className="button-row">
              <span className="prerequisite-name">
                {prerequisite.name} <span className="quiet">({STATUS_INFO[prerequisite.status].label})</span>
              </span>
              <button className="text-button strong" disabled={busy !== null} onClick={() => learnFirst(prerequisite.conceptId)}>
                {prerequisite.status === "learning" ? "Continue its lesson" : "Learn it first"}
              </button>
              <button className="text-button" disabled={busy !== null} onClick={() => testIt(prerequisite.conceptId)}>
                Test it
              </button>
            </p>
          ))}
        </div>
      )}
      <p>The tutor writes the lesson from these sections of your books:</p>
      <ul className="plain-list sources-list">
        {view.sources.map((source) => (
          <li key={source.sectionId}>
            {source.book}, section {source.ref} {source.title}
            {source.page ? `, page ${source.page}` : ""}
          </li>
        ))}
      </ul>
      <p>
        <button className="button" onClick={start} disabled={busy !== null}>
          {busy === "start" ? (
            <>
              <Spinner />
              Writing the lesson
            </>
          ) : view.missingPrerequisites.length > 0 ? "Start the lesson anyway" : "Start the lesson"}
        </button>
      </p>
      {busy === "start" && (
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

function LessonBody({ view, onChange }: { view: LessonView; onChange: (view: LessonView) => void }) {
  const lesson = view.lesson!;
  const [open, setOpen] = useState<LessonReference | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const mastered = view.concept.status === "mastered";

  const ask = async () => {
    setAsking(true);
    setError(null);
    try {
      onChange(await postJson<LessonView>(`/api/lessons/${lesson.id}/messages`, { text: question }));
      setQuestion("");
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end" }));
    } catch (problem) {
      setError((problem as Error).message);
    }
    setAsking(false);
  };

  const startTest = async () => {
    setTesting(true);
    setActionError(null);
    try {
      const { sessionId } = await postJson<{ sessionId: number }>(`/api/concepts/${view.concept.id}/check`);
      window.location.hash = href.session(sessionId);
    } catch (problem) {
      setActionError((problem as Error).message);
      setTesting(false);
    }
  };

  // Skip the test, for example for a simple concept. The concept becomes mastered.
  const skipTest = async () => {
    setSkipping(true);
    setActionError(null);
    try {
      onChange(await postJson<LessonView>(`/api/concepts/${view.concept.id}/skip-test`));
    } catch (problem) {
      setActionError((problem as Error).message);
    }
    setSkipping(false);
  };

  const teachAgain = async () => {
    setRewriting(true);
    setActionError(null);
    try {
      onChange(await postJson<LessonView>(`/api/concepts/${view.concept.id}/lesson`, { again: true }));
      window.scrollTo({ top: 0 });
    } catch (problem) {
      setActionError((problem as Error).message);
    }
    setRewriting(false);
  };

  return (
    <>
      <ConceptHeader view={view} onChange={onChange} />
      {lesson.references.length === 0 && (
        <p className="warning">This lesson has no reference that the tutor could find in your books. Check it against the book sections.</p>
      )}
      <article className="reading lesson">
        <CitedMarkdown text={lesson.text} references={lesson.references} onOpen={setOpen} />
      </article>

      {lesson.references.length > 0 && (
        <section aria-labelledby="references-heading">
          <h2 id="references-heading">References</h2>
          <ReferenceList references={lesson.references} onOpen={setOpen} />
        </section>
      )}

      <section aria-labelledby="questions-heading" className="chat">
        <h2 id="questions-heading">Questions</h2>
        {view.messages.length === 0 && <p className="quiet">Ask about anything in the lesson that is not clear.</p>}
        {view.messages.map((message) =>
          message.role === "user" ? (
            <p key={message.id} className="chat-question">
              {message.text}
            </p>
          ) : (
            <div key={message.id} className="chat-answer reading">
              <CitedMarkdown text={message.text} references={message.references} onOpen={setOpen} />
              <ReferenceList references={message.references} onOpen={setOpen} />
            </div>
          ),
        )}
        <div ref={end} />
        <div className="chat-input">
          <label htmlFor="question" className="visually-hidden">
            Your question
          </label>
          <textarea
            id="question"
            rows={3}
            value={question}
            placeholder="Ask a question about the lesson"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && question.trim() && !asking) void ask();
            }}
          />
          <button className="button" onClick={ask} disabled={asking || question.trim() === ""}>
            {asking ? (
              <>
                <Spinner />
                Writing the answer
              </>
            ) : (
              "Ask"
            )}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="after-heading">
        <h2 id="after-heading">After the lesson</h2>
        {mastered ? (
          <p>The concept is mastered.</p>
        ) : (
          <>
            <p>
              The test has 3 new questions: recall, explain, and apply. To pass, answer 2 questions correctly. The apply question must be one
              of them.
              {view.failedTests > 0 && ` You did not pass the test ${view.failedTests} ${view.failedTests === 1 ? "time" : "times"}.`}
            </p>
            <p>For a simple concept, skip the test. The concept then becomes mastered.</p>
            <p>If the lesson was not clear, the tutor can teach the concept again from a different angle.</p>
          </>
        )}
        <p className="button-row">
          {mastered && view.next && (
            <a className="button" href={href.lesson(view.next.conceptId)}>
              Next lesson: {view.next.name}
            </a>
          )}
          {!mastered && (
            <>
              <button className="button" onClick={startTest} disabled={testing || rewriting || skipping}>
                {testing ? "Starting the test" : view.openTestId ? "Continue the test" : "Test me"}
              </button>
              <button className="button secondary" onClick={skipTest} disabled={testing || rewriting || skipping}>
                Skip the test
              </button>
            </>
          )}
          <button className="text-button strong" onClick={teachAgain} disabled={rewriting || testing || skipping}>
            {rewriting ? (
              <>
                <Spinner />
                Writing a new lesson
              </>
            ) : (
              "Teach it again"
            )}
          </button>
          <a className="text-link" href={href.queue(view.concept.theme.slug)}>
            Back to the study queue
          </a>
        </p>
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
      </section>

      {open && <SectionPanel sectionId={open.sectionId} quote={open.quote} onClose={() => setOpen(null)} />}
    </>
  );
}
