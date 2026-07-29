import { describe, expect, test } from "bun:test";
import { sentryIssueSource } from "../src/providers/sentry.js";

const issueResponse = {
  id: "123456",
  title: "TypeError: project owner is missing",
  level: "error",
  firstSeen: "2026-07-29T00:40:00.000Z",
  lastSeen: "2026-07-29T00:42:18.219Z",
  project: {
    id: "42",
    slug: "api",
  },
};

const eventResponse = {
  id: "event-789",
  eventID: "event-789",
  title: "TypeError: project owner is missing",
  message: "",
  dateCreated: "2026-07-29T00:42:18.219Z",
  tags: [
    { key: "environment", value: "production" },
    { key: "release", value: "api@4f18c28" },
  ],
  contexts: {
    application: {
      customer_id: "cus_9182",
      project_id: "prj_441",
    },
  },
  release: {
    version: "api@4f18c28",
  },
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TypeError",
            value: "project owner is missing",
            stacktrace: {
              frames: [
                {
                  filename: "src/projects/update.ts",
                  function: "updateProject",
                  lineNo: 42,
                  inApp: true,
                },
              ],
            },
          },
        ],
      },
    },
    {
      type: "request",
      data: {
        url: "https://api.example.com/projects/prj_441",
        method: "PATCH",
        headers: [["Cf-Ray", "83f1d84d6d7a21ab"]],
      },
    },
  ],
};

describe("Sentry issue source", () => {
  test("retrieves and normalizes a Sentry issue and recommended event", async () => {
    const requestedUrls: string[] = [];
    const source = sentryIssueSource({
      authToken: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        requestedUrls.push(url);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-token",
        );
        return Response.json(
          url.endsWith("/events/recommended/") ? eventResponse : issueResponse,
        );
      },
    });

    const issue = await source.fetchIssue(
      "https://sentry.io/organizations/acme/issues/123456/",
      {
        caseId: "tc_sentry_test",
        signal: new AbortController().signal,
      },
    );

    expect(requestedUrls).toEqual([
      "https://sentry.io/api/0/organizations/acme/issues/123456/",
      "https://sentry.io/api/0/organizations/acme/issues/123456/events/recommended/",
    ]);
    expect(issue.release).toBe("api@4f18c28");
    expect(issue.stackFrames).toEqual([
      {
        filename: "src/projects/update.ts",
        function: "updateProject",
        lineNumber: 42,
        inApp: true,
      },
    ]);
    expect(issue.entities.map((entity) => entity.kind)).toEqual([
      "cloudflare.ray_id",
      "customer.id",
      "project.id",
    ]);
  });

  test("requires an organization for bare issue ids", () => {
    const source = sentryIssueSource({ authToken: "test-token" });
    expect(source.canHandle("123456")).toBeFalse();

    const configured = sentryIssueSource({
      authToken: "test-token",
      organization: "acme",
    });
    expect(configured.canHandle("123456")).toBeTrue();
  });

  test("accepts organization-subdomain issue URLs with query parameters", () => {
    const source = sentryIssueSource({ authToken: "test-token" });

    expect(
      source.canHandle(
        "https://posty.sentry.io/issues/7392124237/?query=is%3Aunresolved&referrer=issue-stream",
      ),
    ).toBeTrue();
  });
});
