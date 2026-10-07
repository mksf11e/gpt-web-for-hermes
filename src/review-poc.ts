import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { logFailedToolResponse, runLoggedToolOperation, textBlock } from "./tool-surfaces/shared.js";

const TOOL_NAME = "wait_for_review_request";
const DEFAULT_TIMEOUT_SECONDS = 420;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 480;
const POLL_INTERVAL_MS = 500;

const pendingReviewSchema = z.object({
  review_id: z.string(),
  payload: z.string(),
});

export type ReviewReadyResult = {
  status: "review_ready";
  review_id: string;
  payload: string;
  waited_seconds: number;
};

export type ReviewWaitTimeoutResult = {
  status: "timeout";
  continue_waiting: true;
  waited_seconds: number;
};

export type ReviewPocResult = ReviewReadyResult | ReviewWaitTimeoutResult;

export interface WaitForReviewRequestOptions {
  pendingFile: string;
  timeoutSeconds: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export function reviewPocPendingPath(stateDir: string): string {
  return join(stateDir, "review-poc", "pending.json");
}

export function resolveTimeoutSeconds(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) return DEFAULT_TIMEOUT_SECONDS;

  if (!Number.isInteger(timeoutSeconds)
    || timeoutSeconds < MIN_TIMEOUT_SECONDS
    || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new RangeError(
      `timeout_seconds must be a whole number of seconds between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`,
    );
  }

  return timeoutSeconds;
}

export async function waitForReviewRequest(
  options: WaitForReviewRequestOptions,
): Promise<ReviewPocResult> {
  const { pendingFile, timeoutSeconds } = options;
  const sleep = options.sleep ?? sleepFor;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + resolveTimeoutSeconds(timeoutSeconds) * 1_000;

  for (;;) {
    const pending = await readPendingReview(pendingFile);
    if (pending) {
      await consumePendingReview(pendingFile);
      return {
        status: "review_ready",
        review_id: pending.review_id,
        payload: pending.payload,
        waited_seconds: elapsedSeconds(now() - startedAt),
      };
    }

    const remainingMilliseconds = deadline - now();
    if (remainingMilliseconds <= 0) {
      return {
        status: "timeout",
        continue_waiting: true,
        waited_seconds: elapsedSeconds(now() - startedAt),
      };
    }

    await sleep(Math.min(POLL_INTERVAL_MS, remainingMilliseconds));
  }
}

export function registerReviewPocTool(
  server: McpRegistrationTarget,
  config: ServerConfig,
): void {
  const pendingFile = reviewPocPendingPath(config.stateDir);

  server.registerTool(
    TOOL_NAME,
    {
      title: "Wait for review request",
      description: [
        "Block until an outside process drops a review request for this DevSpace installation.",
        "It reads only the fixed file review-poc/pending.json inside the DevSpace state directory, then consumes that file exactly once so the same review is never delivered twice.",
        "Whenever it returns status \"timeout\", call it again immediately so a single assistant turn can stay alive across hours of waiting.",
      ].join(" "),
      inputSchema: {
        timeout_seconds: z
          .number()
          .optional()
          .describe(
            `How long to block before returning. Defaults to ${DEFAULT_TIMEOUT_SECONDS}. Allowed range ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds.`,
          ),
      },
      outputSchema: {
        status: z.enum(["review_ready", "timeout"]),
        review_id: z.string().optional(),
        payload: z.string().optional(),
        continue_waiting: z.boolean().optional(),
        waited_seconds: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ timeout_seconds }) => {
      const startedAt = performance.now();

      let timeoutSeconds: number;
      try {
        timeoutSeconds = resolveTimeoutSeconds(timeout_seconds);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logFailedToolResponse(config, { tool: TOOL_NAME }, [textBlock(message)], startedAt);
        return {
          content: [textBlock(message)],
          isError: true,
        };
      }

      const outcome = await runLoggedToolOperation(
        config,
        { tool: TOOL_NAME },
        startedAt,
        () => waitForReviewRequest({ pendingFile, timeoutSeconds }),
      );

      return {
        content: [textBlock(outcomeText(outcome))],
        structuredContent: { ...outcome },
      };
    },
  );
}

function outcomeText(outcome: ReviewPocResult): string {
  if (outcome.status === "review_ready") {
    return `Review request ${outcome.review_id} is ready after ${outcome.waited_seconds} seconds of waiting.`;
  }

  return `No review request arrived within ${outcome.waited_seconds} seconds. Call ${TOOL_NAME} again to keep waiting.`;
}

// The POC consumes each review exactly once, so the next wait cannot deliver
// the same request again and a later one can take its place.
async function consumePendingReview(pendingFile: string): Promise<void> {
  await rm(pendingFile, { force: true });
}

async function readPendingReview(
  pendingFile: string,
): Promise<{ review_id: string; payload: string } | null> {
  let contents: string;
  try {
    contents = await readFile(pendingFile, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }

  return pendingReviewSchema.parse(JSON.parse(contents));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function elapsedSeconds(elapsedMilliseconds: number): number {
  return Math.round(elapsedMilliseconds / 1_000);
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
