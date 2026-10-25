# CapcomdClient: transport spike

Contract: MarvinAmador7/capcomd `feat/harness-phase0-contract` @ 710e41d (`openapi/capcomd.json` copied to `Sources/CapcomdClient/openapi.json`; swift-openapi-generator build plugin).
- `Transport.swift`: AsyncHTTPClient over the Unix socket (`http+unix`), explicit `Host: localhost` and bearer token.
- `Generated.swift`: a ClientTransport for the generated `Client` over the same socket.
- `SSE.swift`: an incremental SSE parser. `EventStream.swift`: a resumable stream (Last-Event-ID, stream.reset leads to a reconnect and a fresh snapshot, dedupe by seq).
- `mock/server.ts`: a Bun mock. PROVISIONAL parts are marked there: the SSE route, the snapshot frame, stream.reset and the 401 body.

Run: `PATH=~/swift/usr/bin:$PATH swift test` (Bun is required; set BUN_BIN if the Bun binary lives somewhere else).
