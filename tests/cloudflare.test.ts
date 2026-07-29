import { describe, expect, test } from "bun:test";
import type { SearchIntent } from "../src/contracts.js";
import { cloudflareWorkersSource } from "../src/providers/cloudflare.js";

const intent: SearchIntent = {
  id: "sq_test",
  sourceId: "cloudflare-workers",
  entity: {
    kind: "cloudflare.ray_id",
    value: "83f1d84d6d7a21ab",
  },
  timeRange: {
    from: "2026-07-29T00:37:18.219Z",
    to: "2026-07-29T00:47:18.219Z",
  },
  mode: "exact",
  limit: 100,
  depth: 0,
  reason: "The Sentry event contained a Cloudflare Ray ID.",
  causedByEvidenceIds: ["ev_sentry"],
};

describe("Cloudflare Workers evidence source", () => {
  test("compiles an intent and normalizes structured Worker logs", async () => {
    const source = cloudflareWorkersSource({
      accountId: "account-123",
      apiToken: "test-token",
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://api.cloudflare.com/client/v4/accounts/account-123/workers/observability/telemetry/query",
        );
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-token",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          queryId: "sq_test",
          timeframe: {
            from: 1785285438219,
            to: 1785286038219,
          },
          limit: 100,
          parameters: {
            datasets: [],
            filterCombination: "and",
            filters: [],
            needle: {
              value: "83f1d84d6d7a21ab",
              isRegex: false,
              matchCase: false,
            },
            limit: 100,
            view: "events",
          },
        });
        return Response.json({
          success: true,
          errors: [],
          result: {
            events: {
              events: [
                {
                  $metadata: {
                    id: "log-1",
                    service: "api-production",
                    level: "info",
                    message: "Request for cus_9182 accepted",
                    outcome: "ok",
                    eventType: "cf-worker-log",
                  },
                  dataset: "cloudflare-workers",
                  timestamp: 1785285737900,
                  source: {
                    cf: { ray_id: "83f1d84d6d7a21ab" },
                    request_id: "req_8348a",
                    customer_id: "cus_9182",
                    project_id: "prj_441",
                  },
                },
              ],
            },
          },
        });
      },
    });

    const records = [];
    for await (const record of source.search(intent, {
      caseId: "tc_test",
      signal: new AbortController().signal,
    })) {
      records.push(record);
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.source.externalId).toBe("log-1");
    expect(records[0]?.timestamp).toBe("2026-07-29T00:42:17.900Z");
    expect(records[0]?.service).toBe("api-production");
    expect(records[0]?.attributes).toEqual({
      dataset: "cloudflare-workers",
      outcome: "ok",
      eventType: "cf-worker-log",
    });
    expect(records[0]?.entities.map((entity) => entity.kind)).toEqual([
      "cloudflare.ray_id",
      "request.id",
      "customer.id",
      "project.id",
    ]);
    expect(records[0]?.message).toBe("Request for [redacted:customer.id] accepted");
    expect(records[0]?.redactions).toEqual([
      { path: "message", reason: "personal entity" },
    ]);
  });

  test("rejects searches without credentials before making a request", async () => {
    const source = cloudflareWorkersSource();
    const run = async () => {
      for await (const record of source.search(intent, {
        caseId: "tc_test",
        signal: new AbortController().signal,
      })) {
        void record;
      }
    };

    await expect(run()).rejects.toThrow("CLOUDFLARE_API_TOKEN");
  });
});
