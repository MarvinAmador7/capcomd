// First import of the CLI entry point: persisted settings (~/.capcomd/config.json, the project's
// .capcomd/config.json, the boxd key from the OS keychain) become environment defaults before any other
// module reads the environment. Real env vars win. CAPCOMD_NO_CONFIG=1 skips it (tests set it).
import { applyConfig } from "../config/store";

if (!process.env.CAPCOMD_NO_CONFIG) {
  try { applyConfig(process.env); } catch { /* a broken config file must not break the CLI */ }
}
