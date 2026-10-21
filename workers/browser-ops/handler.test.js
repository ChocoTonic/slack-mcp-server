import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserWorker } from "./handler.js";

function fixture({ errorAt, value } = {}) {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push(["goto", url, options]);
      if (errorAt === "goto") throw new Error("navigation failed");
    },
    async title() { return "Example title"; },
    async content() { return "<html><body>Example</body></html>"; },
    async evaluate() { return value; },
    async screenshot(options) {
      calls.push(["screenshot", options]);
      return new Uint8Array([137, 80, 78, 71]);
    },
  };
  const browser = {
    async newPage() {
      if (errorAt === "newPage") throw new Error("page failed");
      return page;
    },
    async close() { calls.push(["close"]); },
  };
  const worker = createBrowserWorker(async (binding) => {
    calls.push(["launch", binding]);
    if (errorAt === "launch") throw new Error("launch failed");
    return browser;
  });
  const env = { BROWSER: { binding: "test" }, BROWSER_OPS_KEY: "secret" };
  const request = (mode = "title", headers = { "x-browser-key": "secret" }) =>
    new Request(`https://worker.test/?url=https%3A%2F%2Fexample.test%2F&mode=${mode}`, { headers });
  return { worker, env, calls, request };
}

test("authentication and query validation happen before launching a browser", async () => {
  const f = fixture();
  assert.equal((await f.worker.fetch(f.request("title", {}), f.env)).status, 401);
  assert.equal((await f.worker.fetch(new Request("https://worker.test/", {
    headers: { "x-browser-key": "secret" },
  }), f.env)).status, 400);
  assert.deepEqual(f.calls, []);
});

test("title mode preserves the response contract and closes its browser", async () => {
  const f = fixture();
  const response = await f.worker.fetch(f.request(), f.env);
  assert.deepEqual(await response.json(), {
    status: "ok", mode: "title", url: "https://example.test/", title: "Example title",
  });
  assert.deepEqual(f.calls, [
    ["launch", f.env.BROWSER],
    ["goto", "https://example.test/", { waitUntil: "domcontentloaded", timeout: 30000 }],
    ["close"],
  ]);
});

test("content mode returns HTML", async () => {
  const f = fixture();
  const response = await f.worker.fetch(f.request("content"), f.env);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(await response.text(), "<html><body>Example</body></html>");
  assert.deepEqual(f.calls.at(-1), ["close"]);
});

test("text and links modes retain their JSON payloads", async () => {
  const text = fixture({ value: "Page text" });
  assert.equal((await (await text.worker.fetch(text.request("text"), text.env)).json()).text, "Page text");
  const links = [{ href: "https://example.test/next", text: "Next" }];
  const f = fixture({ value: links });
  const result = await (await f.worker.fetch(f.request("links"), f.env)).json();
  assert.equal(result.count, 1);
  assert.deepEqual(result.links, links);
});

test("screenshots retain PNG bytes and disable caching", async () => {
  const f = fixture();
  const response = await f.worker.fetch(f.request("screenshot"), f.env);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
  assert.deepEqual(f.calls.at(-2), ["screenshot", { type: "png", fullPage: true }]);
  assert.deepEqual(f.calls.at(-1), ["close"]);
});

for (const errorAt of ["launch", "newPage", "goto"]) {
  test(`${errorAt} failure returns a browser error and cleans up created resources`, async () => {
    const f = fixture({ errorAt });
    const response = await f.worker.fetch(f.request(), f.env);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, "browser_failure");
    assert.equal(f.calls.some(([name]) => name === "close"), errorAt !== "launch");
  });
}

test("unsupported modes return a client error and close the browser", async () => {
  const f = fixture();
  assert.equal((await f.worker.fetch(f.request("unknown"), f.env)).status, 400);
  assert.deepEqual(f.calls.at(-1), ["close"]);
});
