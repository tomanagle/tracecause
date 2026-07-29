import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type {
  EvidenceSource,
  KnowledgeMapping,
  NormalizedEvidence,
} from "../src/contracts.js";
import { fixtureCloudflareSource, fixtureIssueSource } from "../src/fixtures.js";
import { initializeRepository } from "../src/init.js";
import { investigate } from "../src/investigation.js";
import {
  promoteKnowledgeEffect,
  recordKnowledgeObservationsEffect,
  showKnowledgeEffect,
  validateKnowledgeEffect,
} from "../src/knowledge.js";

const confirmedMapping: KnowledgeMapping = {
  schemaVersion: "1",
  id: "km_api_cloudflare",
  kind: "service.correspondence",
  from: { type: "sentry.project", key: "api" },
  to: { type: "cloudflare.service", key: "api-production" },
  confidence: 0.9,
  confirmationCount: 2,
  firstObservedAt: "2026-07-28T00:00:00.000Z",
  lastConfirmedAt: "2026-07-29T00:00:00.000Z",
  provenance: [
    { caseId: "tc_previous", observationType: "correlated_service_evidence" },
  ],
  status: "confirmed",
};

describe("investigation knowledge", () => {
  test("ranks a confirmed provider mapping first and audits its use", async () => {
    let unrelatedSearches = 0;
    const unrelated: EvidenceSource = {
      id: "unrelated",
      supports: () => true,
      async *search() {
        unrelatedSearches += 1;
        const records: NormalizedEvidence[] = [];
        for (const record of records) yield record;
      },
    };

    const result = await investigate({
      reference: "fixture:sentry-issue",
      issueSource: fixtureIssueSource,
      evidenceSources: [unrelated, fixtureCloudflareSource],
      caseId: "tc_knowledge",
      now: () => new Date("2026-07-29T03:00:00.000Z"),
      knowledgeMappings: [confirmedMapping],
    });

    expect(unrelatedSearches).toBe(0);
    expect(result.context.knowledge.usedMappings).toEqual([
      {
        mappingId: "km_api_cloudflare",
        confidence: 0.9,
        rationale:
          "sentry.project api maps to cloudflare.service api-production, so cloudflare-workers was ranked first.",
      },
    ]);
  });

  test("records only structural observations and promotes them explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracecause-knowledge-"));
    try {
      await initializeRepository(root);
      const first = await investigate({
        reference: "fixture:sentry-issue",
        issueSource: fixtureIssueSource,
        evidenceSources: [fixtureCloudflareSource],
        caseId: "tc_first",
        now: () => new Date("2026-07-29T03:00:00.000Z"),
      });
      await Effect.runPromise(
        recordKnowledgeObservationsEffect(root, first.context, first.evidence),
      );
      const secondContext = {
        ...first.context,
        caseId: "tc_second",
        updatedAt: "2026-07-30T03:00:00.000Z",
      };
      await Effect.runPromise(
        recordKnowledgeObservationsEffect(root, secondContext, first.evidence),
      );

      const beforePromotion = await Effect.runPromise(validateKnowledgeEffect(root));
      expect(beforePromotion).toEqual({ confirmed: 0, observations: 1 });
      const localState = await readFile(
        join(root, ".tracecause", "state", "observations.json"),
        "utf8",
      );
      expect(localState).toContain("api-production");
      expect(localState).not.toContain("cus_9182");
      expect(localState).not.toContain("prj_441");

      expect(await Effect.runPromise(promoteKnowledgeEffect(root))).toBe(1);
      const knowledge = await Effect.runPromise(showKnowledgeEffect(root));
      expect(knowledge.mappings[0]?.status).toBe("confirmed");
      expect(knowledge.mappings[0]?.confirmationCount).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
