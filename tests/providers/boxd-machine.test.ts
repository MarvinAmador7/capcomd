// Inside a boxd machine: the env is only a hint, a token from its metadata service is the test (isolated machines,
// like every agent VM capcomd starts, get "VM is isolated").
import { expect, test } from "bun:test";
import { boxdMachine } from "../../src/providers/boxd-machine";

// /proc/net/route with a default route via 10.40.0.1 (hex, little-endian).
const ROUTE = "Iface\tDestination\tGateway\tFlags\nenp0s1\t00000000\t0100280A\t0003\n";
const read = () => ROUTE;

test("no hints: not in a boxd machine, and nothing is asked", async () => {
  let asked = false;
  expect(await boxdMachine({}, { read, fetch: (async () => { asked = true; return new Response(""); }) as any })).toMatchObject({ inside: false, credentials: false });
  expect(asked).toBe(false);
});

test("a token from the metadata service at the gateway: its credentials are usable (the token isn't kept)", async () => {
  let url = "";
  const m = await boxdMachine({ BOXD_VM_NAME: "hermes" }, { read, fetch: (async (u: string) => { url = u; return Response.json({ token: "t0ken", expires_at: 1, api_url: "https://boxd.sh:9443" }); }) as any });
  expect(url).toBe("http://10.40.0.1:9002/v1/auth/token");
  expect(m).toEqual({ inside: true, credentials: true, name: "hermes", detail: "inside boxd machine hermes: using its credentials" });
  expect(JSON.stringify(m)).not.toContain("t0ken");
});

test("an isolated machine: inside, but no credentials", async () => {
  const m = await boxdMachine({ BOXD_VM_ID: "vm-1" }, { read, fetch: (async () => new Response("VM is isolated", { status: 403 })) as any });
  expect(m).toMatchObject({ inside: true, credentials: false, detail: "in a boxd machine whose metadata service gives no credentials (403: VM is isolated)" });
});

test("no metadata service (hints but nothing answers): no credentials", async () => {
  const m = await boxdMachine({ BOXD_VM_ID: "vm-1" }, { read, fetch: (async () => { throw new Error("ECONNREFUSED"); }) as any });
  expect(m).toMatchObject({ inside: true, credentials: false, detail: "in a boxd machine, but its metadata service didn't answer" });
});
