/** CLI: create a timestamped SQLite backup and prune to the newest 14. */
import { createBackup, listBackups } from "./server/lib/backup";
const info = createBackup();
console.log(JSON.stringify({ created: info, total: listBackups().length }, null, 2));
