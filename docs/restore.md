# Restoring an upgrade backup

1. Stop the application and every process using the database. Confirm no connection remains open.
2. Read the adjacent JSON report and choose the backup made immediately before the intended upgrade. The backup is a complete SQLite snapshot, including committed WAL contents and the migration history at that time.
3. Verify the selected snapshot using `moonmolt verify --db backups/before.sqlite --dir migrations --worker --format json`. Use the original unchanged migration prefix, optionally adding the application's known `--expected-application-id` and expected historical version. Pending migrations are normal for a pre-upgrade backup; verification never applies them. A successful check confirms history/schema, full SQLite integrity and foreign keys for that snapshot. Also confirm the backup belongs to the intended user/database; application IDs identify file formats, not individual tenants.
4. Preserve the current database and any `-wal`, `-shm` or `-journal` sidecars in a separate location while all connections are closed. This retains the post-upgrade state for investigation.
5. Replace the original database file with a copy of the chosen backup. Do not leave sidecars from the replaced database beside the restored file. Restore appropriate filesystem permissions.
6. Run `moonmolt verify --db app.db --dir migrations --worker` against the restored file and inspect the application's important records before restarting. This opens a read-only connection and does not replay the historical business checks, since those conditions described earlier migration-time data. A failed verification is not a repair instruction; keep the evidence and investigate before using the restored file.

Restoration replaces the whole database, including any data written since the backup. It is an operator action, not an automatic down migration. MoonMolt's automatic backups are retained until the operator removes them; plan storage retention for the application.

A running SQLite database must not be backed up or restored using ordinary file copies. MoonMolt creates its snapshot through SQLite's backup API; only the completed standalone backup is copied into the rehearsal database.
