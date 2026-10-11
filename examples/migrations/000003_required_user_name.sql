-- Requires --rebuild. Preserve IDs used by orders.user_id.
CREATE TABLE users_new(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
INSERT INTO users_new(id,name) SELECT id,name FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
