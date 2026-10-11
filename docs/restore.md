# Restoring an upgrade backup

1. Stop the application and every process using the database. Confirm no connection remains open.
2. Read the adjacent JSON report and choose the backup made immediately before the intended upgrade. The backup is a complete SQLite snapshot, including committed WAL contents and the migration history at that time.
3. Preserve the current database and any `-wal`, `-shm` or `-journal` sidecars in a separate location while all connections are closed. This retains the post-upgrade state for investigation.
4. Replace the original database file with a copy of the chosen backup. Do not leave sidecars from the replaced database beside the restored file. Restore appropriate filesystem permissions.
5. Open the restored database and check `PRAGMA quick_check;`, `PRAGMA foreign_key_check;`, and the application's important records. Run `moonmolt status` against the corresponding unchanged migration files before restarting the application.

Restoration replaces the whole database, including any data written since the backup. It is an operator action, not an automatic down migration. MoonMolt's automatic backups are retained until the operator removes them; plan storage retention for the application.

A running SQLite database must not be backed up or restored using ordinary file copies. MoonMolt creates its snapshot through SQLite's backup API; only the completed standalone backup is copied into the rehearsal database.
