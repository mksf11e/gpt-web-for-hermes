import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  registerReviewPocTool,
  resolveTimeoutSeconds,
  reviewPocPendingPath,
  waitForReviewRequest,
} from "./review-poc.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

interface ReviewPocFixture {
  client: Client;
  config: ServerConfig;
  stateDir: string;
  pendingFile: string;
}

async function fixture(t: TestContext): Promise<ReviewPocFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-poc-test-"));
  const stateDir = join(root, ".state");
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    storage: { stateDir },
    logging: { toolCalls: true },
  }));

  const server = new McpServer({ name: "devspace-review-poc-test", version: "1.0.0" });
  registerReviewPocTool(server, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-review-poc-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, config, stateDir, pendingFile: reviewPocPendingPath(stateDir) };
}

async function writePendingFile(pendingFile: string, reviewId: string): Promise<void> {
  await mkdir(join(pendingFile, ".."), { recursive: true });
  await writeFile(
    pendingFile,
    JSON.stringify({ review_id: reviewId, payload: `payload for ${reviewId}` }),
    "utf8",
  );
}

async function assertFileAbsent(path: string): Promise<void> {
  await assert.rejects(() => readFile(path, "utf8"), /ENOENT/);
}

// A clock the test advances by hand, so no test waits in real time.
function controllableClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

test("wait_for_review_request blocks until the timeout and asks to be called again", async (t) => {
  const context = await fixture(t);
  const clock = controllableClock();
  const polled: number[] = [];

  const outcome = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 5,
    now: clock.now,
    sleep: async (milliseconds) => {
      polled.push(milliseconds);
      clock.advance(milliseconds);
    },
  });

  assert.deepEqual(outcome, {
    status: "timeout",
    continue_waiting: true,
    waited_seconds: 5,
  });
  // 5 seconds at a 500 ms poll interval, with the last sleep shortened to the deadline.
  assert.deepEqual(polled, [500, 500, 500, 500, 500, 500, 500, 500, 500, 500]);
  await assertFileAbsent(context.pendingFile);
});

test("wait_for_review_request consumes pending.json after a successful review_ready result", async (t) => {
  const context = await fixture(t);
  await writePendingFile(context.pendingFile, "POC-001");

  const outcome = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 60,
    now: () => 0,
    sleep: async () => assert.fail("must not sleep when a review is pending"),
  });

  assert.deepEqual(outcome, {
    status: "review_ready",
    review_id: "POC-001",
    payload: "payload for POC-001",
    waited_seconds: 0,
  });
  await assertFileAbsent(context.pendingFile);
});

test("wait_for_review_request does not return the same review twice", async (t) => {
  const context = await fixture(t);
  await writePendingFile(context.pendingFile, "POC-001");

  const first = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 60,
    now: () => 0,
    sleep: async () => assert.fail("must not sleep when a review is pending"),
  });
  assert.equal(first.status, "review_ready");
  assert.equal(first.review_id, "POC-001");

  const clock = controllableClock();
  const second = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 5,
    now: clock.now,
    sleep: async (milliseconds) => {
      clock.advance(milliseconds);
    },
  });

  assert.deepEqual(second, {
    status: "timeout",
    continue_waiting: true,
    waited_seconds: 5,
  });
});

test("a review placed after the first one is consumed is returned normally", async (t) => {
  const context = await fixture(t);
  await writePendingFile(context.pendingFile, "POC-001");

  const first = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 60,
    now: () => 0,
    sleep: async () => assert.fail("must not sleep when a review is pending"),
  });
  assert.equal(first.status, "review_ready");
  assert.equal(first.review_id, "POC-001");

  await writePendingFile(context.pendingFile, "POC-002");

  const second = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 60,
    now: () => 0,
    sleep: async () => assert.fail("must not sleep when a review is pending"),
  });

  assert.deepEqual(second, {
    status: "review_ready",
    review_id: "POC-002",
    payload: "payload for POC-002",
    waited_seconds: 0,
  });
  await assertFileAbsent(context.pendingFile);
});

test("wait_for_review_request returns the pending review when the file appears while waiting", async (t) => {
  const context = await fixture(t);
  const clock = controllableClock();
  let pollCount = 0;

  const outcome = await waitForReviewRequest({
    pendingFile: context.pendingFile,
    timeoutSeconds: 420,
    now: clock.now,
    sleep: async (milliseconds) => {
      clock.advance(milliseconds);
      pollCount += 1;
      if (pollCount === 4) await writePendingFile(context.pendingFile, "review-mid-wait");
    },
  });

  assert.deepEqual(outcome, {
    status: "review_ready",
    review_id: "review-mid-wait",
    payload: "payload for review-mid-wait",
    waited_seconds: 2,
  });
});

test("wait_for_review_request rejects an out-of-range timeout", async (t) => {
  const context = await fixture(t);

  for (const timeoutSeconds of [4, 481, 0, -1, 12.5, Number.NaN]) {
    await assert.rejects(
      () => waitForReviewRequest({
        pendingFile: context.pendingFile,
        timeoutSeconds,
        now: () => 0,
        sleep: async () => undefined,
      }),
      /timeout_seconds must be a whole number of seconds between 5 and 480/,
    );
  }
});

test("resolveTimeoutSeconds defaults to 420 seconds", () => {
  assert.equal(resolveTimeoutSeconds(), 420);
  assert.equal(resolveTimeoutSeconds(480), 480);
  assert.equal(resolveTimeoutSeconds(5), 5);
});

test("wait_for_review_request watches only review-poc/pending.json under the state directory", async (t) => {
  const context = await fixture(t);

  assert.equal(context.pendingFile, join(context.stateDir, "review-poc", "pending.json"));
  assert.equal(context.pendingFile, join(context.config.stateDir, "review-poc", "pending.json"));
});

test("the MCP tool returns review_ready and consumes the pending file", async (t) => {
  const context = await fixture(t);
  await writePendingFile(context.pendingFile, "review-over-mcp");

  const response = await context.client.callTool({
    name: "wait_for_review_request",
    arguments: { timeout_seconds: 5 },
  });

  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, {
    status: "review_ready",
    review_id: "review-over-mcp",
    payload: "payload for review-over-mcp",
    waited_seconds: 0,
  });
  await assertFileAbsent(context.pendingFile);
});

test("the MCP tool delivers POC-001 then POC-002 without repeating the first", async (t) => {
  const context = await fixture(t);
  await writePendingFile(context.pendingFile, "POC-001");

  const first = await context.client.callTool({
    name: "wait_for_review_request",
    arguments: { timeout_seconds: 5 },
  });
  assert.deepEqual(first.structuredContent, {
    status: "review_ready",
    review_id: "POC-001",
    payload: "payload for POC-001",
    waited_seconds: 0,
  });
  await assertFileAbsent(context.pendingFile);

  const stillWaiting = await context.client.callTool({
    name: "wait_for_review_request",
    arguments: { timeout_seconds: 5 },
  });
  assert.deepEqual(stillWaiting.structuredContent, {
    status: "timeout",
    continue_waiting: true,
    waited_seconds: 5,
  });

  await writePendingFile(context.pendingFile, "POC-002");
  const second = await context.client.callTool({
    name: "wait_for_review_request",
    arguments: { timeout_seconds: 5 },
  });
  assert.deepEqual(second.structuredContent, {
    status: "review_ready",
    review_id: "POC-002",
    payload: "payload for POC-002",
    waited_seconds: 0,
  });
  await assertFileAbsent(context.pendingFile);
});

test("the MCP tool returns timeout with continue_waiting and leaves the state directory untouched", async (t) => {
  const context = await fixture(t);

  const response = await context.client.callTool({
    name: "wait_for_review_request",
    arguments: { timeout_seconds: 5 },
  });

  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, {
    status: "timeout",
    continue_waiting: true,
    waited_seconds: 5,
  });
  await assertFileAbsent(context.pendingFile);
  await assertFileAbsent(join(context.stateDir, "review-poc"));
});

test("the MCP tool reports an invalid timeout instead of waiting", async (t) => {
  const context = await fixture(t);

  const response = await context.client.callTool({
    name: "wait_for_review_request",
    arguments: { timeout_seconds: 900 },
  });

  assert.equal(response.isError, true);
  const errorText = (response.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.match(errorText, /timeout_seconds must be a whole number of seconds between 5 and 480/);
  await assertFileAbsent(context.pendingFile);
});
