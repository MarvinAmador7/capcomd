// The SQLite database every capcomd actor keeps: rivetkit's `db()`, with rivetkit's SQLite profiling narrowed to nothing.
//
// rivetkit 3.x profiles every statement and transaction of every actor by default, and warns about what capcomd doesn't
// use: each unnamed transaction ("SQLite transaction is unnamed") and every transaction shape past its 8 tracked ones
// ("SQLite profiling capacity reached"), dozens of lines in a daemon's log and every test engine's. capcomd reads none of
// those metrics. A filter that names one statement capcomd never runs turns the tracking off (rivetkit: "both empty
// means all queries"). RIVETKIT_SQLITE_PROFILING (rivetkit's own process override, a JSON object of filterQueries /
// filterQueryFingerprints) still turns it back on to look into a slow actor.
import { db as rivetDb } from "rivetkit/db";

const NO_PROFILING = { filterQueries: ["SELECT 'capcomd: no SQLite profiling'"] };

export const db = (config: Omit<NonNullable<Parameters<typeof rivetDb>[0]>, "profiling"> = {}) => rivetDb({ ...config, profiling: NO_PROFILING });
