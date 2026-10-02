// Increase SCHEMA_VERSION for each change to SCHEMA.
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
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
