CREATE TABLE IF NOT EXISTS ai_counts (
  install_id TEXT NOT NULL,
  month TEXT NOT NULL,
  requests INTEGER NOT NULL,
  approvals INTEGER NOT NULL,
  PRIMARY KEY (install_id, month)
);
