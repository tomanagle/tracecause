import { describe, expect, test } from "bun:test";
import type { SearchIntent } from "../src/contracts.js";
import {
  cloudWatchLogsInsightsQuery,
  cloudWatchLogsSource,
  type CloudWatchFetch,
} from "../src/providers/cloudwatch.js";

const intent: SearchIntent = {
  id: "si_cloudwatch",
  sourceId: "aws-cloudwatch",
  entity: {
    kind: "request.id",
    value: "req/123",
  },
  timeRange: {
    from: "2026-07-29T00:00:00.000Z",
    to: "2026-07-29T00:10:00.000Z",
  },
  mode: "exact",
  limit: 50,
  depth: 1,
  reason: "Follow the request across application logs",
  causedByEvidenceIds: ["ev_issue"],
};

const collect = async <Value>(input: AsyncIterable<Value>): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of input) values.push(value);
  return values;
};

describe("CloudWatch Logs evidence source", () => {
  test("builds a bounded Logs Insights query", () => {
    expect(cloudWatchLogsInsightsQuery(intent)).toBe(
      [
        "fields @timestamp, @message, @logStream, @log",
        "| filter @message like /req\\/123/",
        "| sort @timestamp asc",
        "| limit 50",
      ].join("\n"),
    );
  });

  test("signs, executes, and normalizes structured wide events", async () => {
    const requests: Array<{ target: string | null; body: unknown }> = [];
    const fetch: CloudWatchFetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({
        target: headers.get("x-amz-target"),
        body,
      });
      expect(headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256");
      expect(headers.get("x-amz-security-token")).toBe("session-token");
      if (headers.get("x-amz-target") === "Logs_20140328.StartQuery") {
        return Response.json({ queryId: "query-1" });
      }
      return Response.json({
        status: "Complete",
        results: [
          [
            { field: "@ptr", value: "ptr-1" },
            { field: "@timestamp", value: "2026-07-29 00:04:00.000" },
            { field: "@logStream", value: "api/worker-1" },
            {
              field: "@message",
              value:
                '{"level":"error","request_id":"req/123","customer_id":"cus_42","project_id":"prj_8","message":"customer cus_42 failed"}',
            },
          ],
        ],
      });
    };
    const source = cloudWatchLogsSource({
      region: "ap-southeast-2",
      logGroupNames: ["/aws/lambda/api"],
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        sessionToken: "session-token",
      },
      fetch,
      now: () => new Date("2026-07-29T00:05:00.000Z"),
    });

    const evidence = await collect(
      source.search(intent, {
        caseId: "tc_cloudwatch",
        signal: new AbortController().signal,
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.target).toBe("Logs_20140328.StartQuery");
    expect(requests[0]?.body).toEqual({
      logGroupNames: ["/aws/lambda/api"],
      startTime: 1_785_283_200,
      endTime: 1_785_283_800,
      queryString: cloudWatchLogsInsightsQuery(intent),
      limit: 50,
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source.providerId).toBe("aws-cloudwatch");
    expect(evidence[0]?.service).toBe("api/worker-1");
    expect(evidence[0]?.message).toContain("[redacted:customer.id]");
    expect(evidence[0]?.entities.map((entity) => entity.kind)).toEqual([
      "request.id",
      "customer.id",
      "project.id",
    ]);
  });

  test("requires credentials before making a request", async () => {
    let called = false;
    const source = cloudWatchLogsSource({
      logGroupNames: ["/aws/lambda/api"],
      credentialProvider: async () => {
        throw new Error("No AWS credentials");
      },
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });

    await expect(
      collect(
        source.search(intent, {
          caseId: "tc_cloudwatch",
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow("AWS credentials could not be resolved");
    expect(called).toBeFalse();
  });
});
