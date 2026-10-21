// bunfig.toml preload for `bun test`: never apply the developer's own ~/.capcomd/config.json or a project
// .capcomd/config.json (e.g. CAPCOMD_SANDBOX=boxd from `capcomd setup`) to the CLIs and engines tests start.
process.env.CAPCOMD_NO_CONFIG = "1";
