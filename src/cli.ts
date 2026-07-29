import { resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { Effect } from "effect";
import { writeCaseEffect } from "./case-store.js";
import { fixtureCloudflareSource, fixtureIssueSource } from "./fixtures.js";
import { initializeRepository } from "./init.js";
import { investigate } from "./investigation.js";
import { cloudflareWorkersSource } from "./providers/cloudflare.js";
import { sentryIssueSource } from "./providers/sentry.js";
import { renderContextMarkdown, renderTerminalSummary } from "./reporter.js";

const investigateCommand = defineCommand({
  meta: {
    name: "investigate",
    description: "Investigate an issue and build a local evidence case",
  },
  args: {
    reference: {
      type: "positional",
      description: "Issue URL, issue identifier, or fixture reference",
      required: true,
    },
    format: {
      type: "string",
      description: "terminal, agent, or json",
      default: "terminal",
    },
    output: {
      type: "string",
      description: "Case root directory or stdout",
      default: process.cwd(),
    },
    "max-queries": {
      type: "string",
      description: "Maximum evidence searches",
      default: "20",
    },
    "max-depth": {
      type: "string",
      description: "Maximum recursive pivot depth",
      default: "4",
    },
  },
  async run({ args }) {
    const isFixture = fixtureIssueSource.canHandle(args.reference);
    const issueSource = isFixture
      ? fixtureIssueSource
      : sentryIssueSource({
          ...(process.env.SENTRY_AUTH_TOKEN === undefined
            ? {}
            : { authToken: process.env.SENTRY_AUTH_TOKEN }),
          ...(process.env.SENTRY_ORG === undefined
            ? {}
            : { organization: process.env.SENTRY_ORG }),
        });
    if (!issueSource.canHandle(args.reference)) {
      throw new Error("Unsupported issue reference.");
    }
    const result = await investigate({
      reference: args.reference,
      issueSource,
      evidenceSources: isFixture
        ? [fixtureCloudflareSource]
        : [
            cloudflareWorkersSource({
              ...(process.env.CLOUDFLARE_API_TOKEN === undefined
                ? {}
                : { apiToken: process.env.CLOUDFLARE_API_TOKEN }),
              ...(process.env.CLOUDFLARE_ACCOUNT_ID === undefined
                ? {}
                : { accountId: process.env.CLOUDFLARE_ACCOUNT_ID }),
            }),
          ],
      maxQueries: Number.parseInt(args["max-queries"], 10),
      maxDepth: Number.parseInt(args["max-depth"], 10),
    });

    if (args.output === "stdout") {
      if (args.format === "json") {
        process.stdout.write(`${JSON.stringify(result.context, null, 2)}\n`);
      } else {
        process.stdout.write(renderContextMarkdown(result.context));
      }
      return;
    }

    const root = resolve(args.output);
    const written = await Effect.runPromise(
      writeCaseEffect(root, result.context, result.evidence),
    );
    process.stdout.write(
      `${renderTerminalSummary(result.context, written.directory)}\n`,
    );
  },
});

const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize Rootcause in the current repository",
  },
  async run() {
    await initializeRepository(process.cwd());
    process.stdout.write("Initialized .rootcause/\n");
  },
});

const main = defineCommand({
  meta: {
    name: "rootcause",
    version: "0.0.0",
    description: "Evidence-driven production incident investigation",
  },
  subCommands: {
    init: initCommand,
    investigate: investigateCommand,
  },
});

void runMain(main);
