-- Quiz Game Database Schema

CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,       -- JSON array of 4 strings
  answer INTEGER NOT NULL,     -- 0=A, 1=B, 2=C, 3=D
  category TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quiz_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  played_at TEXT NOT NULL,
  results TEXT NOT NULL,
  player_count INTEGER NOT NULL DEFAULT 0
);

-- Installation creates configuration only; there are no seeded quizzes or games.
CREATE TABLE IF NOT EXISTS app_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), site_name TEXT NOT NULL, language TEXT NOT NULL,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (client_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL);
