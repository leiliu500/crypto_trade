import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const serverAtMs = 1_788_800_000_000;
const app = await readFile("src/dashboard/public/app.js", "utf8");
const lifecycle = app.slice(0, app.indexOf("function render(s)"));

interface TestSnapshot { generatedAtMs: number; marker?: string }
interface FetchRequest {
  signal?: AbortSignal;
  resolve: (response: { ok: boolean; json: () => Promise<TestSnapshot> }) => void;
}

function browser(wallOffsetMs = 0) {
  const clock = { monotonic: 1_000, wall: serverAtMs + wallOffsetMs };
  class BrowserDate extends Date { public static override now() { return clock.wall; } }
  const requests: FetchRequest[] = [], rendered: TestSnapshot[] = [];
  const timers = new Map<number, { deadline: number; callback: () => void }>();
  const nodes = new Map<string, { className: string; innerHTML: string; textContent: string }>();
  const sockets: FakeSocket[] = [];
  let timerSequence = 0;
  class FakeSocket {
    public static readonly CONNECTING = 0;
    public static readonly OPEN = 1;
    public static readonly CLOSED = 3;
    public readyState = FakeSocket.CONNECTING;
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    public constructor(public readonly url: string) { sockets.push(this); }
    public addEventListener(type: string, callback: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    }
    public fire(type: string, event: unknown = {}) {
      if (type === "open") this.readyState = FakeSocket.OPEN;
      if (type === "close") this.readyState = FakeSocket.CLOSED;
      for (const callback of this.listeners.get(type) ?? []) callback(event);
    }
    public snapshot(value: TestSnapshot) { this.fire("message", { data: JSON.stringify({ type: "snapshot", data: value }) }); }
    public close() { this.fire("close"); }
  }
  const context = createContext({
    Date: BrowserDate, performance: { now: () => clock.monotonic }, AbortController,
    location: { protocol: "https:", host: "dashboard.example" }, WebSocket: FakeSocket,
    document: { getElementById: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { className: "", innerHTML: "", textContent: "" });
      return nodes.get(id);
    } },
    fetch: (_url: string, options: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      const request: FetchRequest = { resolve };
      if (options.signal) {
        request.signal = options.signal;
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }
      requests.push(request);
    }),
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = ++timerSequence; timers.set(id, { deadline: clock.monotonic + delayMs, callback }); return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => 0,
    render: (snapshot: TestSnapshot) => { rendered.push(snapshot); },
    refreshCrossAssetPanels: () => {},
  });
  runInContext(lifecycle, context);
  const evaluate = <T = unknown>(code: string): T => runInContext(code, context) as T;
  return {
    clock, requests, rendered, sockets, nodes, evaluate,
    accept: (atMs = serverAtMs) => evaluate<boolean>(`acceptSnapshot({generatedAtMs:${atMs}})`),
    age: () => evaluate<number>("snapshotAgeMs()"),
    now: () => evaluate<number>("dashboardNowMs()"),
    refresh: () => evaluate<Promise<void>>("refreshDashboard()"),
    paused: (value: boolean) => { evaluate(`state.paused=${value}`); },
    advance: (elapsedMs: number) => { clock.monotonic += elapsedMs; },
    respond: (index: number, snapshot: TestSnapshot, ok = true) => {
      assert.ok(requests[index], `request ${index} exists`);
      requests[index]!.resolve({ ok, json: async () => snapshot });
    },
    runDueTimers: () => {
      for (const [id, timer] of [...timers]) if (timer.deadline <= clock.monotonic) {
        timers.delete(id); timer.callback();
      }
    },
  };
}

test("dashboard freshness uses elapsed receipt time despite browser clock offsets and changes", () => {
  for (const offset of [-3_600_000, 3_600_000]) {
    const b = browser(offset);
    assert.equal(b.age(), Infinity, "no snapshot has been accepted");
    assert.equal(b.accept(), true); assert.equal(b.age(), 0); assert.equal(b.now(), serverAtMs);
    b.advance(1_001); b.clock.wall += 86_400_000;
    assert.equal(b.age(), 1_001); assert.equal(b.now(), serverAtMs + 1_001);
    b.advance(4_000); b.clock.wall -= 172_800_000;
    assert.equal(b.age(), 5_001); assert.equal(b.now(), serverAtMs + 5_001);
    assert.equal(b.evaluate<string>(`relative(${serverAtMs})`), "5s ago");
  }
});

test("repeated, invalid, and out-of-order snapshots cannot renew dashboard freshness", () => {
  const b = browser(); assert.equal(b.accept(), true); b.advance(6_000);
  assert.equal(b.accept(), false); assert.equal(b.accept(serverAtMs - 1), false);
  for (const invalid of ["null", "{}", "{generatedAtMs:NaN}", "{generatedAtMs:Infinity}", "{generatedAtMs:'1788800000001'}"])
    assert.equal(b.evaluate<boolean>(`acceptSnapshot(${invalid})`), false, invalid);
  assert.equal(b.age(), 6_000); assert.equal(b.now(), serverAtMs + 6_000);
  assert.equal(b.accept(serverAtMs + 6_000), true); assert.equal(b.age(), 0);
});

test("HTTP fallback recovers a stalled dashboard and repeated responses do not revive stale data", async () => {
  const b = browser(); b.accept(); b.advance(6_000);
  const pending = b.refresh(); assert.equal(b.requests.length, 1);
  b.respond(0, { generatedAtMs: serverAtMs + 6_000, marker: "recovered" }); await pending;
  assert.equal(b.age(), 0); assert.equal(b.rendered.at(-1)?.marker, "recovered");
  b.advance(6_000);
  const duplicate = b.refresh(); assert.equal(b.requests.length, 2);
  b.respond(1, { generatedAtMs: serverAtMs + 6_000, marker: "duplicate" }); await duplicate;
  assert.equal(b.age(), 6_000); assert.equal(b.rendered.length, 1);
});

test("HTTP fallback cannot overwrite a newer websocket snapshot", async () => {
  const b = browser(); b.accept(); b.advance(6_000);
  b.evaluate("connect()"); const socket = b.sockets[0]!; socket.fire("open");
  const pending = b.refresh();
  socket.snapshot({ generatedAtMs: serverAtMs + 7_000, marker: "newer-stream" });
  b.advance(500);
  b.respond(0, { generatedAtMs: serverAtMs + 6_500, marker: "older-http" }); await pending;
  assert.equal(b.rendered.length, 1); assert.equal(b.rendered[0]?.marker, "newer-stream");
  assert.equal(b.age(), 500); assert.equal(b.now(), serverAtMs + 7_500);
});

test("HTTP refresh is bounded to one pending request and at least five seconds between attempts", async () => {
  const b = browser(); b.accept(); b.advance(6_000);
  const first = b.refresh(); await b.refresh(); await b.refresh();
  assert.equal(b.requests.length, 1);
  b.respond(0, { generatedAtMs: serverAtMs }); await first;
  b.advance(4_999); await b.refresh(); assert.equal(b.requests.length, 1);
  b.advance(1); const second = b.refresh(); assert.equal(b.requests.length, 2);
  b.respond(1, { generatedAtMs: serverAtMs + 11_000 }); await second;
  assert.equal(b.age(), 0);
});

test("HTTP timeout releases the pending request so fallback can retry", async () => {
  const b = browser(); const first = b.refresh();
  assert.equal(b.requests.length, 1); assert.ok(b.requests[0]!.signal);
  b.advance(5_000); b.runDueTimers(); await first;
  assert.equal(b.requests[0]!.signal!.aborted, true);
  const retry = b.refresh(); assert.equal(b.requests.length, 2);
  b.respond(1, { generatedAtMs: serverAtMs + 5_000 }); await retry;
  assert.equal(b.age(), 0);
});

test("pause ignores stream and in-flight HTTP responses until new data arrives after resume", async () => {
  const b = browser(); b.accept(); b.advance(6_000);
  b.evaluate("connect()"); const socket = b.sockets[0]!; socket.fire("open");
  b.paused(true); await b.refresh(); assert.equal(b.requests.length, 0);
  socket.snapshot({ generatedAtMs: serverAtMs + 6_000 }); assert.equal(b.age(), 6_000);
  b.paused(false); const pending = b.refresh(); assert.equal(b.requests.length, 1);
  b.paused(true); b.respond(0, { generatedAtMs: serverAtMs + 6_001 }); await pending;
  assert.equal(b.age(), 6_000); assert.equal(b.rendered.length, 0);
  b.paused(false); socket.snapshot({ generatedAtMs: serverAtMs + 6_002 });
  assert.equal(b.age(), 0); assert.equal(b.rendered.length, 1);
});

test("websocket open and duplicate reconnect messages cannot conceal a stalled stream", () => {
  const b = browser(); b.accept(); b.advance(6_000);
  b.evaluate("connect()"); const socket = b.sockets[0]!; socket.fire("open");
  assert.equal(socket.url, "wss://dashboard.example/ws"); assert.equal(b.age(), 6_000);
  socket.snapshot({ generatedAtMs: serverAtMs }); assert.equal(b.age(), 6_000);
  socket.snapshot({ generatedAtMs: serverAtMs + 6_000 }); assert.equal(b.age(), 0);
  assert.equal(b.rendered.length, 1);
});

test("bootstrap starts the websocket without waiting for the initial HTTP request", async () => {
  const b = browser(); const started = b.evaluate<Promise<void>>("bootstrap()");
  assert.equal(b.sockets.length, 1); assert.equal(b.requests.length, 1);
  b.respond(0, { generatedAtMs: serverAtMs }); await started;
});
