// Each migration changes the schema from one version to the next. Add a new migration
// for each change, and do not change the old migrations: databases of users have them already.

const V1 = `
CREATE TABLE themes (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  runners    TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE books (
  id         INTEGER PRIMARY KEY,
  theme_id   INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  file       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ingesting' CHECK (status IN ('ingesting', 'ready', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (theme_id, slug)
);

CREATE TABLE sections (
  id            INTEGER PRIMARY KEY,
  book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter       INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  chapter_title TEXT NOT NULL,
  title         TEXT NOT NULL,
  page          TEXT,
  path          TEXT NOT NULL,
  words         INTEGER NOT NULL,
  UNIQUE (book_id, chapter, number)
);

CREATE TABLE modules (
  id       INTEGER PRIMARY KEY,
  theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name     TEXT NOT NULL
);

CREATE TABLE concepts (
  id          INTEGER PRIMARY KEY,
  theme_id    INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  module_id   INTEGER NOT NULL REFERENCES modules(id),
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  objective   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('knowledge', 'skill')),
  level       TEXT NOT NULL CHECK (level IN ('basic', 'intermediate', 'advanced')),
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new', 'to_test', 'known', 'failed', 'queued', 'learning', 'mastered', 'skipped')),
  queue_pos   INTEGER,
  review_step INTEGER NOT NULL DEFAULT 0,
  review_at   TEXT,
  UNIQUE (theme_id, slug)
);

CREATE TABLE concept_sources (
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  quote      TEXT NOT NULL,
  PRIMARY KEY (concept_id, section_id)
);

CREATE TABLE concept_prereqs (
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  prereq_id  INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  PRIMARY KEY (concept_id, prereq_id),
  CHECK (concept_id <> prereq_id)
);

CREATE TABLE questions (
  id         INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('diagnose', 'test', 'review')),
  kind       TEXT NOT NULL CHECK (kind IN ('choice', 'short', 'apply')),
  text       TEXT NOT NULL,
  choices    TEXT,
  answer     TEXT NOT NULL,
  key_points TEXT NOT NULL DEFAULT '[]',
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL
);

CREATE TABLE attempts (
  id          INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL,
  score       INTEGER NOT NULL CHECK (score IN (0, 1, 2)),
  feedback    TEXT NOT NULL DEFAULT '',
  disputed    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lessons (
  id         INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lesson_messages (
  id         INTEGER PRIMARY KEY,
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE exercises (
  id         INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  runner     TEXT NOT NULL,
  spec       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

// Version 2: sessions group the questions of a diagnosis, a test, or a review.
const V2 = `
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY,
  theme_id   INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  module_id  INTEGER REFERENCES modules(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('diagnose', 'test', 'review')),
  status     TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'finished', 'failed')),
  error      TEXT,
  prepared   INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE session_concepts (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  result     TEXT CHECK (result IN ('known', 'failed')),
  PRIMARY KEY (session_id, concept_id)
);

ALTER TABLE questions ADD COLUMN session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE questions ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
`;

// Version 3: lessons and chat answers keep their references as JSON.
const V3 = `
ALTER TABLE lessons ADD COLUMN refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE lesson_messages ADD COLUMN refs TEXT NOT NULL DEFAULT '[]';
`;

// Version 4: a lesson is short. On request, the tutor writes a detailed lesson with references.
// A lesson from before this version is already detailed.
const V4 = `
ALTER TABLE lessons ADD COLUMN detail TEXT;
ALTER TABLE lessons ADD COLUMN detail_refs TEXT NOT NULL DEFAULT '[]';
UPDATE lessons SET detail = text, detail_refs = refs;
`;

// Version 5: the user stars the important concepts. The tutor has no review schedule, so its columns go.
// The CHECK constraints of sessions and questions keep the value 'review', because a change needs a rebuild of the table.
const V5 = `
ALTER TABLE concepts ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE concepts DROP COLUMN review_step;
ALTER TABLE concepts DROP COLUMN review_at;
`;

// Version 6: a lesson has one text, with references. The length of the lesson follows the concept.
// A detailed lesson replaces its short lesson. A short lesson with no detailed lesson stays, with no references.
const V6 = `
UPDATE lessons SET text = detail, refs = detail_refs WHERE detail IS NOT NULL;
ALTER TABLE lessons DROP COLUMN detail;
ALTER TABLE lessons DROP COLUMN detail_refs;
`;

export const MIGRATIONS = [V1, V2, V3, V4, V5, V6];
export const SCHEMA_VERSION = MIGRATIONS.length;

