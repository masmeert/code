import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Read once, when the storage modules load: every test in the run shares this database.
process.env.MASSCODE_DATA_DIR = mkdtempSync(join(tmpdir(), "masscode-test-"));
