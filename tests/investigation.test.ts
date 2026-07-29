import { describe, expect, test } from "bun:test";
import {
  investigationContextSchema,
  type EvidenceSource,
  type NormalizedEvidence,
} from "../src/contracts.js";
import { fixtureCloudflareSource, fixtureIssueSource } from "../src/fixtures.js";
import { investigate } from "../src/investigation.js";
import { renderContextMarkdown } from "../src/reporter.js";

const fixedTimes = [
  "2026-07-29T03:00:00.000Z",
  "2026-07-29T03:00:00.100Z",
  "2026-07-29T03:00:00.200Z",
  "2026-07-29T03:00:00.300Z",
  "2026-07-29T03:00:00.400Z",
  "2026-07-29T03:00:00.500Z",
  "2026-07-29T03:00:00.600Z",
];
const lastFixedTime = "2026-07-29T03:00:00.600Z";

const runFixture = () => {
  let index = 0;
  return investigate({
    reference: "fixture:sentry-issue",
    issueSource: fixtureIssueSource,
    evidenceSources: [fixtureCloudflareSource],
    caseId: "rc_test",
    now: () => new Date(fixedTimes[index++] ?? lastFixedTime),
  });
};

describe("fixture investigation", () => {
  test("follows ray id to customer and project history", async () => {
    const result = await runFixture();
    const context = investigationContextSchema.parse(result.context);

    expect(context.caseId).toBe("rc_test");
    expect(context.entities.map((item) => item.kind)).toContain("cloudflare.ray_id");
    expect(context.entities.map((item) => item.kind)).toContain("customer.id");
    expect(context.entities.map((item) => item.kind)).toContain("project.id");
    expect(context.timeline.map((item) => item.summary)).toContain(
      "Customer imported project without owner",
    );
    expect(context.completion.reason).toBe("frontier-exhausted");
  });

  test("deduplicates equivalent evidence and searches", async () => {
    const result = await runFixture();
    const fingerprints = result.evidence.map((record) => record.fingerprint);
    const searchKeys = result.context.searches.map(
      (search) =>
        `${search.intent.sourceId}:${search.intent.entity.kind}:${search.intent.entity.value}:${search.intent.mode}`,
    );

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(new Set(searchKeys).size).toBe(searchKeys.length);
  });

  test("renders evidence citations and masks personal values", async () => {
    const result = await runFixture();
    const markdown = renderContextMarkdown(result.context);
    const persistedJson = JSON.stringify(result);

    expect(markdown).toContain("[evidence:");
    expect(markdown).toContain("`customer.id`: [masked]");
    expect(markdown).not.toContain("cus_9182");
    expect(persistedJson).not.toContain("cus_9182");
    expect(persistedJson).toContain("customer_1");
  });

  test("stops at the query budget", async () => {
    const result = await investigate({
      reference: "fixture:sentry-issue",
      issueSource: fixtureIssueSource,
      evidenceSources: [fixtureCloudflareSource],
      caseId: "rc_budget",
      maxQueries: 1,
      now: () => new Date("2026-07-29T03:00:00.000Z"),
    });

    expect(result.context.searches).toHaveLength(1);
    expect(result.context.completion.reason).toBe("max-queries");
  });

  test("propagates Effect interruption to provider abort signals", async () => {
    let observedAbort = false;
    const blockingSource: EvidenceSource = {
      id: "blocking",
      supports: () => true,
      async *search(_intent, context) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            observedAbort = true;
            resolve();
            return;
          }
          context.signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        const noRecords: NormalizedEvidence[] = [];
        for (const record of noRecords) {
          yield record;
        }
      },
    };
    const controller = new AbortController();
    const running = investigate({
      reference: "fixture:sentry-issue",
      issueSource: fixtureIssueSource,
      evidenceSources: [blockingSource],
      caseId: "rc_cancel",
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    await expect(running).rejects.toThrow();
    expect(observedAbort).toBeTrue();
  });
});
