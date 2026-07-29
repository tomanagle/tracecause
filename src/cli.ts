import { resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { Effect } from "effect";
import {
  fileCredentialStore,
  loginSentryDevice,
  resolveCloudflareCredentials,
  resolveCredentials,
  sentryOAuthClientId,
  type ProviderName,
} from "./auth.js";
import type { EvidenceSource } from "./contracts.js";
import { writeCaseEffect } from "./case-store.js";
import { fixtureCloudflareSource, fixtureIssueSource } from "./fixtures.js";
import { initializeRepository } from "./init.js";
import { investigate } from "./investigation.js";
import {
  forgetKnowledgeEffect,
  inspectKnowledgeEffect,
  loadConfirmedKnowledgeEffect,
  promoteKnowledgeEffect,
  recordKnowledgeObservationsEffect,
  validateKnowledgeEffect,
} from "./knowledge.js";
import { cloudflareWorkersSource } from "./providers/cloudflare.js";
import { cloudWatchLogsSource } from "./providers/cloudwatch.js";
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
    const repositoryRoot = process.cwd();
    const credentialStore = fileCredentialStore();
    const sentryCredentials = await resolveCredentials("sentry", credentialStore);
    const issueSource = isFixture
      ? fixtureIssueSource
      : sentryIssueSource({
          ...(sentryCredentials.credentials?.accessToken === undefined
            ? {}
            : { authToken: sentryCredentials.credentials.accessToken }),
          ...(sentryCredentials.credentials?.organization === undefined
            ? {}
            : { organization: sentryCredentials.credentials.organization }),
        });
    if (!issueSource.canHandle(args.reference)) {
      throw new Error("Unsupported issue reference.");
    }
    const cloudWatchLogGroups = (process.env.TRACECAUSE_AWS_LOG_GROUPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const liveEvidenceSources: EvidenceSource[] = [];
    const cloudflareCredentials = await resolveCloudflareCredentials({
      store: credentialStore,
    });
    if (cloudflareCredentials.source !== "missing") {
      liveEvidenceSources.push(
        cloudflareWorkersSource({
          ...(cloudflareCredentials.credentials?.accessToken === undefined
            ? {}
            : { apiToken: cloudflareCredentials.credentials.accessToken }),
          ...(cloudflareCredentials.credentials?.accountId === undefined
            ? {}
            : { accountId: cloudflareCredentials.credentials.accountId }),
        }),
      );
    }
    if (cloudWatchLogGroups.length > 0) {
      liveEvidenceSources.push(
        cloudWatchLogsSource({
          logGroupNames: cloudWatchLogGroups,
          ...(process.env.AWS_REGION === undefined
            ? process.env.AWS_DEFAULT_REGION === undefined
              ? {}
              : { region: process.env.AWS_DEFAULT_REGION }
            : { region: process.env.AWS_REGION }),
        }),
      );
    }
    if (!isFixture && liveEvidenceSources.length === 0) {
      throw new Error(
        "No evidence source is configured. Run `npx wrangler login --use-keyring` for Cloudflare, or configure CloudWatch.",
      );
    }
    const knowledgeMappings = await Effect.runPromise(
      loadConfirmedKnowledgeEffect(repositoryRoot),
    );
    const result = await investigate({
      reference: args.reference,
      issueSource,
      evidenceSources: isFixture ? [fixtureCloudflareSource] : liveEvidenceSources,
      maxQueries: Number.parseInt(args["max-queries"], 10),
      maxDepth: Number.parseInt(args["max-depth"], 10),
      knowledgeMappings,
    });
    const observationIds = await Effect.runPromise(
      recordKnowledgeObservationsEffect(
        repositoryRoot,
        result.context,
        result.evidence,
      ),
    );
    result.context.knowledge.newObservationIds = observationIds;

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

const providerArgument = (): {
  type: "positional";
  description: string;
  required: true;
} => ({
  type: "positional",
  description: "sentry or cloudflare",
  required: true,
});

const parseProvider = (value: string): ProviderName => {
  if (value === "sentry" || value === "cloudflare") return value;
  throw new Error("Provider must be sentry or cloudflare.");
};

const authLoginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate a provider for local use",
  },
  args: {
    provider: providerArgument(),
  },
  async run({ args }) {
    if (args.provider !== "sentry") {
      throw new Error(
        "Cloudflare authentication is managed by Wrangler. Run `npx wrangler login --use-keyring`, then retry.",
      );
    }
    const clientId = process.env.TRACECAUSE_SENTRY_CLIENT_ID ?? sentryOAuthClientId;
    const credentials = await loginSentryDevice({
      clientId,
      store: fileCredentialStore(),
      onVerification: ({ url, userCode, expiresIn }) => {
        process.stdout.write(
          `Open ${url}\nEnter code: ${userCode}\nThis code expires in ${expiresIn} seconds.\n`,
        );
      },
    });
    process.stdout.write(
      `Authenticated with Sentry organization ${credentials.organization ?? "unknown"}.\n`,
    );
  },
});

const authStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show the active credential source without exposing secrets",
  },
  args: {
    provider: providerArgument(),
  },
  async run({ args }) {
    const provider = parseProvider(args.provider);
    const resolved =
      provider === "cloudflare"
        ? await resolveCloudflareCredentials({ store: fileCredentialStore() })
        : await resolveCredentials(provider, fileCredentialStore());
    process.stdout.write(
      `${provider}: ${resolved.source}${resolved.missingEnvironmentVariables.length === 0 ? "" : ` (missing ${resolved.missingEnvironmentVariables.join(", ")})`}\n`,
    );
  },
});

const authLogoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Remove locally stored provider credentials",
  },
  args: {
    provider: providerArgument(),
  },
  async run({ args }) {
    const provider = parseProvider(args.provider);
    await fileCredentialStore().remove(provider);
    process.stdout.write(`Removed stored ${provider} credentials.\n`);
  },
});

const authCommand = defineCommand({
  meta: {
    name: "auth",
    description: "Manage provider authentication",
  },
  subCommands: {
    login: authLoginCommand,
    status: authStatusCommand,
    logout: authLogoutCommand,
  },
});

const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize Tracecause in the current repository",
  },
  async run() {
    await initializeRepository(process.cwd());
    process.stdout.write("Initialized .tracecause/\n");
  },
});

const knowledgeShowCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show reviewed repository knowledge",
  },
  async run() {
    const document = await Effect.runPromise(inspectKnowledgeEffect(process.cwd()));
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  },
});

const knowledgeValidateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate reviewed knowledge and local observations",
  },
  async run() {
    const result = await Effect.runPromise(validateKnowledgeEffect(process.cwd()));
    process.stdout.write(
      `Knowledge is valid: ${result.confirmed} reviewed mappings, ${result.observations} local observations.\n`,
    );
  },
});

const knowledgePromoteCommand = defineCommand({
  meta: {
    name: "promote",
    description: "Promote reviewed local observations into knowledge.yaml",
  },
  async run() {
    const promoted = await Effect.runPromise(promoteKnowledgeEffect(process.cwd()));
    process.stdout.write(`Promoted ${promoted} mappings to knowledge.yaml.\n`);
  },
});

const knowledgeForgetCommand = defineCommand({
  meta: {
    name: "forget",
    description: "Remove a mapping from reviewed knowledge and local observations",
  },
  args: {
    id: {
      type: "positional",
      description: "Mapping ID",
      required: true,
    },
  },
  async run({ args }) {
    const removed = await Effect.runPromise(
      forgetKnowledgeEffect(process.cwd(), args.id),
    );
    process.stdout.write(
      removed ? `Forgot mapping ${args.id}.\n` : `Mapping ${args.id} was not found.\n`,
    );
  },
});

const knowledgeCommand = defineCommand({
  meta: {
    name: "knowledge",
    description: "Inspect and review learned investigation structure",
  },
  subCommands: {
    show: knowledgeShowCommand,
    validate: knowledgeValidateCommand,
    promote: knowledgePromoteCommand,
    forget: knowledgeForgetCommand,
  },
});

const main = defineCommand({
  meta: {
    name: "tracecause",
    version: "0.0.0",
    description: "Evidence-driven production incident investigation",
  },
  subCommands: {
    auth: authCommand,
    init: initCommand,
    investigate: investigateCommand,
    knowledge: knowledgeCommand,
  },
});

void runMain(main);
