# Tracecause — Product and Technical Specification

**Status:** Draft v0.4  
**Working product name:** Tracecause
**Primary implementation language:** TypeScript  
**Distribution:** npm package with an executable CLI  
**Primary invocation:** `npx tracecause investigate ...`
**Module format:** ESM only  
**Development toolchain:** Bun, `bun:test`, tsup, Oxlint, and Oxfmt  
**Internal application runtime:** Effect v4 beta  
**Supported runtimes:** Bun, Node.js, and Deno

> Be first on your team to turn a production bug into a detailed root cause and a fix.

---

## 1. Product thesis

Production bugs are rarely explained by a single error event. The useful context is fragmented across issue trackers, logs, source code, releases, traces, requests, customer activity, deployments, and service-specific identifiers.

Tracecause begins with an issue and follows the available evidence dynamically.

For example:

```text
Sentry issue
  contains Cloudflare Ray ID
    → search Cloudflare logs for Ray ID
      reveals customer ID and project ID
        → search surrounding logs for customer ID
        → search surrounding logs for project ID
          reveals an earlier failed operation
            → assemble a timeline and focused context bundle
```

The product does not merely fetch a fixed set of logs. It performs a bounded, explainable investigation:

1. Retrieve the source issue.
2. Extract searchable entities and correlation identifiers.
3. Query configured evidence sources using the strongest identifiers first.
4. Extract additional entities from newly discovered evidence.
5. Follow useful evidence pivots until the investigation budget or stop conditions are reached.
6. Build a provenance-aware timeline and context bundle.
7. Produce an output designed for a human engineer or coding agent to use immediately.

The MVP does **not** replay or reproduce the bug. Replay may be added later as another way to gather or validate context.

---

## 2. MVP product boundary

The first version has one command and one primary outcome:

```bash
npx tracecause investigate "https://sentry.io/organizations/acme/issues/123456/"
```

The command should produce a local investigation case containing:

- A concise incident summary.
- The normalized source issue.
- A timeline of relevant events.
- The identifiers and relationships discovered during investigation.
- The exact searches performed and why they were performed.
- Relevant log excerpts with provenance.
- Relevant stack frames and local source files when resolvable.
- Facts separated from hypotheses.
- Missing context and recommended next steps.
- A token-conscious Markdown document suitable for an AI coding agent.
- Structured JSON suitable for tools and future integrations.

### 2.1 MVP integrations

Initial first-party providers:

- **Issue source:** Sentry.
- **Evidence source:** Cloudflare Workers Observability logs.
- **Evidence source:** AWS CloudWatch Logs Insights.
- **Repository source:** Current local Git checkout.

The architecture must allow later additions without modifying the investigation engine:

- Mezmo.
- Datadog.
- Grafana Loki.
- Elasticsearch or OpenSearch.
- Honeycomb.
- Other issue trackers and error trackers.
- Trace providers.
- Deployment providers.
- Custom company-specific sources.

### 2.2 Explicit MVP non-goals

The MVP will not:

- Reproduce or replay the bug locally.
- Modify application source code.
- Generate or submit a pull request.
- Claim a root cause without supporting evidence.
- Query production databases.
- Provide a hosted service.
- Require an embedded LLM.
- Give an AI agent direct credentials for Sentry or log providers.
- Search indefinitely or expand every identifier it encounters.

---

## 3. Core product principles

### 3.1 Evidence first

Every statement in the output must be classified as one of:

- **Evidence:** Directly retrieved from a configured source.
- **Fact:** Deterministically derived from evidence or repository inspection.
- **Hypothesis:** A possible interpretation that is not proven.
- **Gap:** Information that is still missing.

### 3.2 Provider neutral

The core must not understand Sentry query syntax, Cloudflare query syntax, CloudWatch Logs Insights syntax, or Mezmo syntax.

Providers translate between their APIs and Tracecause's contracts.

### 3.3 Recursive but bounded

Investigation should follow newly discovered clues, but every expansion must be:

- Explainable.
- Deduplicated.
- Subject to configurable depth, query, time, byte, and evidence limits.
- Scored before execution.
- Recorded in an audit trail.

### 3.4 Exact identifiers before broad searches

Prefer high-specificity pivots such as:

1. Trace ID.
2. Cloudflare Ray ID.
3. Request or correlation ID.
4. Event or job ID.
5. Resource ID such as order, project, booking, or payment ID.
6. Customer or user ID.
7. Route, service, error message, or timestamp proximity.

Broader subject searches should normally happen only after a highly specific search has tied the subject to the incident.

### 3.5 Local and agent-friendly

Provider access, evidence retrieval, redaction, and correlation happen locally. The resulting sanitized context is passed to the user's chosen AI agent.

### 3.6 Safe by default

Production logs may contain credentials, personal information, payment data, internal URLs, and proprietary source details.

Tracecause must:

- Redact before writing agent-facing output.
- Never print provider tokens.
- Gitignore all case data by default.
- Avoid storing raw evidence unless explicitly enabled.
- Record which values were redacted.
- Allow sensitive entity types to be excluded from recursive search.
- Limit log excerpts and payload sizes.

### 3.7 The investigation must be inspectable

A user must be able to answer:

- Why did Tracecause perform this query?
- Which identifier caused the query?
- Which evidence introduced that identifier?
- Why did Tracecause stop?
- Which findings are direct evidence?
- What was omitted or redacted?

---

## 4. User experience

### 4.1 Initialise a repository

```bash
npx tracecause init
```

Creates:

```text
.tracecause/
├── config.ts
├── policies.yaml
├── knowledge.yaml
├── state/
│   └── observations.json
├── cases/
└── .gitignore
```

The generated `.gitignore` must ignore the entire `.tracecause/cases/` and
`.tracecause/state/` directories. `knowledge.yaml` is safe, reviewed structural
knowledge intended to be committed and shared with the repository.

### 4.2 Configure sources

```ts
// .tracecause/config.ts
import { defineConfig, fieldEntityExtractor } from "tracecause";
import { sentryIssueSource } from "tracecause/providers/sentry";
import { cloudflareWorkersLogs } from "tracecause/providers/cloudflare-workers";

export default defineConfig({
  issueSources: [
    // Uses credentials from `tracecause auth login sentry` by default.
    sentryIssueSource(),
  ],

  evidenceSources: [
    cloudflareWorkersLogs({
      // Uses the account selected by `tracecause auth login cloudflare`.

      // User-specific structured fields present in application logs.
      entities: [
        fieldEntityExtractor({
          kind: "customer.id",
          role: "subject",
          paths: ["customerId", "customer.id", "context.customer_id"],
          sensitivity: "personal",
        }),
        fieldEntityExtractor({
          kind: "project.id",
          role: "resource",
          paths: ["projectId", "project.id"],
        }),
      ],
    }),
  ],

  investigation: {
    initialWindow: "5m",
    subjectHistoryWindow: "60m",
    resourceHistoryWindow: "30m",
    maxDepth: 4,
    maxQueries: 20,
    maxEvidenceRecords: 500,
    maxEvidenceBytes: "5mb",
    maxWallTime: "2m",
  },

  redaction: {
    mode: "strict",
    retainRawEvidence: false,
  },
});
```

Secrets must be resolved from Tracecause's credential-store abstraction or the
environment. They must never be written into generated configuration files.

#### 4.2.1 Sentry authentication

Tracecause must not assume that Sentry authentication is already configured.
Interactive OAuth is the default local-development experience:

```bash
npx tracecause auth login sentry
```

The command uses Sentry's OAuth 2 device authorization flow:

1. Request a device and user code using Tracecause's registered public OAuth
   client ID and the minimum read scopes required by the provider.
2. Open the returned Sentry verification URL in the user's browser when
   possible, and always print the URL and short user code.
3. Poll at Sentry's instructed interval while the user approves access.
4. Retrieve the access and refresh tokens.
5. Discover and display the Sentry organization selected during authorization.
6. Store the credentials through Tracecause's credential-store abstraction.

The normal interaction should require no token copying:

```text
Opening Sentry to authorize Tracecause...

If the browser does not open, visit:
https://sentry.io/oauth/device/

Enter code: ABCD-EFGH

✓ Connected to Sentry organization: acme
```

Sentry scopes OAuth access to the organization selected during authorization.
Tracecause should initially request `org:read`, `project:read`, and `event:read`,
subject to verification against the exact issue and event endpoints during
provider implementation. Any scope that is not required by those endpoints
must be removed.

Tracecause registers and maintains a Sentry OAuth application and ships its
public client ID. `TRACECAUSE_SENTRY_CLIENT_ID` may override that value for
self-hosted Sentry and integration testing. No Sentry client secret may be
embedded in the CLI. The published release process must include a smoke test
against the registered OAuth client configuration.

The CLI must support:

```bash
tracecause auth login sentry
tracecause auth status sentry
tracecause auth logout sentry
```

Access tokens must be refreshed automatically before expiry. Logout removes the
locally stored credentials and should revoke them remotely when Sentry provides
an applicable revocation mechanism.

Tokens should be stored in the operating system's credential store where a
supported secure backend is available. If no secure credential store is
available, Tracecause must require explicit user confirmation before falling
back to a user-only, permission-restricted credential file and must clearly
report its location and security properties. Credential storage is separate
from repository configuration and case data.

Tracecause must never persist a token in `.tracecause/config.ts`, a case bundle,
diagnostic output, or the query audit trail.

For CI, automation, self-hosted Sentry installations that do not support the
device flow, and explicit user overrides, environment authentication remains
supported:

```bash
export SENTRY_AUTH_TOKEN="..."
export SENTRY_ORG="acme"
```

Credential precedence is:

1. Explicit environment variables.
2. Stored OAuth credentials.
3. A clear unauthenticated error with a suggested login command.

Authentication resolution must be deterministic and friendly to non-interactive
environments:

- When all required environment credentials are present, Tracecause must use
  them without opening a browser, prompting, or reading the local credential
  store.
- A non-interactive investigation with missing or partial credentials must fail
  quickly with the exact missing variable names and the relevant setup command.
- Tracecause must not generate or modify a `.env` file. CI systems should inject
  secrets through their native secret stores, while interactive users should
  receive secure OAuth-backed storage.
- `auth status` must report which credential source is active without printing
  token values.
- Setting environment credentials must provide an intentional per-process
  override of stored OAuth credentials, making CI and local troubleshooting
  behavior predictable.

Before an investigation starts, the Sentry provider's
`validateConfiguration()` implementation must check:

- An environment token or stored OAuth session is available.
- The token can authenticate with Sentry.
- The organization selected by OAuth or configuration is accessible.
- The token can read the issue and representative event required by the
  provider.

`tracecause config validate` performs the same checks without starting an
investigation and reports actionable remediation for missing credentials,
invalid credentials, inaccessible organizations, and insufficient access.

Tracecause may reuse `SENTRY_AUTH_TOKEN` already configured for other Sentry
tooling, but it must not parse or copy credentials from unrelated configuration
files in the MVP.

When a coding agent runs the CLI, the Tracecause subprocess receives only the
environment and local credential-store access available to that agent. This is
the convenient workflow when the user trusts the agent's shell access.
Otherwise, the user runs Tracecause in their own authenticated shell and gives
the agent access only to the sanitized case bundle.

#### 4.2.2 Cloudflare authentication

Interactive OAuth is also the default Cloudflare experience:

```bash
npx tracecause auth login cloudflare
```

Cloudflare does not support the OAuth device authorization grant for
third-party clients. The command therefore uses Authorization Code with PKCE:

1. Generate a unique PKCE verifier, S256 challenge, and CSRF `state`.
2. Start a temporary loopback callback listener.
3. Open Cloudflare's authorization URL in the user's browser.
4. Ask the user to select the account and approve only the permissions required
   to query Workers Observability telemetry.
5. Validate the callback state and exchange the authorization code using the
   verifier. A client secret must not be embedded in the CLI.
6. Store and refresh the resulting credentials through the same credential
   store abstraction used by Sentry.
7. Persist the selected non-secret account ID as provider configuration so the
   user is not asked on every investigation.

Tracecause's Cloudflare OAuth client must be registered as a public client, use
PKCE with `S256`, and request the narrowest scope accepted by the Workers
Observability telemetry query endpoint. Cloudflare account administrators may
disable public OAuth application access; Tracecause must explain that condition
rather than presenting it as an invalid login.

The CLI must support:

```bash
tracecause auth login cloudflare
tracecause auth status cloudflare
tracecause auth logout cloudflare
```

If the loopback browser flow cannot work, such as in some remote or headless
environments, Tracecause must stop with instructions for token-based
authentication rather than weakening the OAuth flow:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
```

Environment credentials remain the intended path for CI and automation.
Credential precedence and secret-handling rules are the same as for Sentry.
Complete Cloudflare environment credentials must likewise bypass OAuth,
browser launch, prompts, and credential-store access.
The Cloudflare provider's `validateConfiguration()` implementation must verify
the selected account and permission to run a bounded Workers Observability
telemetry query before beginning an investigation.

#### 4.2.3 AWS CloudWatch authentication and log groups

CloudWatch Logs Insights uses AWS's standard credential provider chain. Local
developers should authenticate with their existing AWS CLI or IAM Identity
Center profile:

```bash
aws configure sso --profile my-company # first-time profile setup
aws sso login --profile my-company
export AWS_PROFILE="my-company"
export AWS_REGION="ap-southeast-2"
export TRACECAUSE_AWS_LOG_GROUPS="/aws/lambda/api,/aws/lambda/jobs"
```

The provider chain resolves environment variables, IAM Identity Center token
cache, web identity, shared `~/.aws/config` and `~/.aws/credentials` files,
credential processes, ECS task credentials, and EC2 instance credentials.
Environment credentials continue to take precedence for deterministic CI use.

`TRACECAUSE_AWS_LOG_GROUPS` is an explicit, comma-separated allowlist. Tracecause
must not discover or query every log group in an account. The IAM identity
should be restricted to `logs:StartQuery` and `logs:GetQueryResults` on the
intended log groups.

The provider signs Logs Insights requests with AWS Signature Version 4 using
runtime-neutral Web Crypto APIs. Tracecause delegates credential discovery and
refresh to AWS's maintained provider chain and does not copy credentials into
its own credential store. Credentials must never be persisted in the
repository, case bundle, query audit trail, or diagnostic output.

### 4.3 Investigate an issue

```bash
npx tracecause investigate \
  "https://sentry.io/organizations/acme/issues/123456/"
```

Example terminal output:

```text
Tracecause investigation tc_V1StGXR8_Z5jdHi6

Seed issue
  TypeError: Cannot read properties of undefined
  Occurred: 2026-07-29T00:42:18.219Z
  Release: api@4f18c28

Discovered pivots
  cloudflare.ray_id  83f1d84d6d7a21ab
  request.id         req_8348a

Searching Cloudflare Workers Logs
  ✓ Ray ID — 8 records
  ✓ Request ID — 11 records, 7 deduplicated

New pivots
  customer.id        cus_9182
  project.id         prj_441

Searching related history
  ✓ Customer ID — 19 records in the 60 minutes before failure
  ✓ Project ID — 6 records in the 30 minutes before failure

Investigation complete
  1 issue event
  29 relevant log records
  4 related entities
  8 timeline events
  3 context gaps

Context: .tracecause/cases/tc_V1StGXR8_Z5jdHi6/context.md
JSON:    .tracecause/cases/tc_V1StGXR8_Z5jdHi6/context.json
```

### 4.4 Agent-oriented output

```bash
npx tracecause investigate <issue-reference> --format agent
```

This mode should:

- Keep terminal output minimal.
- Produce a compact `context.md`.
- Exclude raw or repetitive logs.
- Include exact source references for every fact.
- Include suggested source files and search terms.
- Include unresolved questions.
- Return a non-zero exit code only for tool failure, not for an incomplete investigation.

Optional direct stdout mode:

```bash
npx tracecause investigate <issue-reference> \
  --format agent \
  --output stdout
```

### 4.5 Machine-readable output

```bash
npx tracecause investigate <issue-reference> --format json
```

The final JSON should conform to the versioned `InvestigationContext` schema.

A streaming mode may emit progress as NDJSON:

```bash
npx tracecause investigate <issue-reference> --format ndjson
```

---

## 5. AI agent integration

### 5.1 MVP integration: the agent runs the CLI

The recommended MVP flow is:

```text
User asks coding agent to investigate a production issue
                         │
                         ▼
Agent runs `npx tracecause investigate <issue> --format agent`
                         │
                         ▼
Tracecause accesses providers locally using configured credentials
                         │
                         ▼
Tracecause writes a sanitized context bundle
                         │
                         ▼
Agent reads context.md and investigates or fixes the code
```

Example instruction to an agent:

```text
Run:

npx tracecause investigate "<issue-url>" --format agent

Then read the generated context.md, inspect the referenced source files,
and use the evidence to identify the likely cause. Do not treat hypotheses
as facts. Tell me what additional evidence would increase confidence.
```

### 5.2 Why CLI-first

CLI-first integration provides:

- Compatibility with any coding agent capable of running local commands.
- No agent-specific protocol in the MVP.
- One workflow for humans, agents, and CI.
- Provider credentials remain inside the Tracecause process.
- Reproducible output independent of the model being used.
- Easy debugging because every query is recorded.
- A clean path to MCP later without making MCP the core architecture.

### 5.3 Agent-facing case contract

The generated case directory:

```text
.tracecause/cases/tc_V1StGXR8_Z5jdHi6/
├── context.md              # Compact context for humans and agents
├── context.json            # Complete normalized context
├── timeline.json
├── entities.json
├── findings.json
├── gaps.json
├── queries.ndjson          # Query audit trail
├── evidence.ndjson         # Sanitized normalized evidence
├── files.json              # Relevant repository files and ranges
└── metadata.json
```

Raw provider responses should not be retained by default.

### 5.4 Future MCP integration

MCP is a later convenience layer, not the source of truth.

A future command may start an MCP server:

```bash
npx tracecause mcp
```

Potential tools:

- `investigate_issue`
- `get_investigation`
- `get_timeline`
- `get_evidence`
- `get_context_gaps`
- `expand_entity`

MCP tools should call the same core APIs as the CLI. They must not implement separate investigation behavior.

### 5.5 Future agent packages

Later releases may generate or install lightweight integrations for common coding agents, such as command templates, skills, or repository instructions. These integrations should invoke the CLI rather than duplicate provider logic.

---

## 6. High-level architecture

```text
┌──────────────────────────────┐
│ CLI                          │
│ npx tracecause investigate │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ Investigation orchestrator   │
│ seed → search → extract      │
│ → score → expand → stop      │
└───────┬───────────┬──────────┘
        │           │
┌───────▼────────┐  │
│ Issue sources │  │
│ Sentry, ...   │  │
└───────┬────────┘  │
        │           │
        ▼           ▼
┌──────────────────────────────┐
│ Normalized evidence store    │
│ records + entities + edges   │
└──────────────┬───────────────┘
               │
        ┌──────▼────────┐
        │ Search planner│
        │ and frontier  │
        └──────┬────────┘
               │ search intents
┌──────────────▼───────────────┐
│ Evidence sources             │
│ Cloudflare, CloudWatch, ...  │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ Context builder              │
│ timeline, findings, gaps,    │
│ repository references       │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ Reporter                     │
│ terminal, Markdown, JSON     │
└──────────────────────────────┘
```

### 6.1 Effect runtime model

Tracecause deliberately uses Effect v4 beta as its internal application runtime.
The project accepts beta API churn in exchange for building against Effect's
current architecture.

The exact Effect beta version must be pinned in `package.json` and `bun.lock`;
semver ranges and automatic beta upgrades are prohibited. Effect upgrades
require an explicit pull request, release-note review, full typecheck, the
complete test suite, bundled-runtime smoke tests, and inspection of public
bundle exports. Effect remains behind Tracecause's internal boundary so beta API
changes cannot leak into public contracts or persisted schemas.

Effect should own the operational parts of the system:

- Investigation orchestration.
- Typed operational errors.
- Provider service composition and first-party provider implementations.
- Structured concurrency and concurrency limits.
- Retry, backoff, timeout, and scheduling policies.
- Cancellation and scoped resource cleanup.
- Evidence streaming.
- Atomic case-store operations.
- Knowledge-map reads and updates.
- Internal structured logging and tracing.
- Replaceable services, clocks, and provider fakes for tests.

The investigation program should make its success type, expected failures, and
required services explicit. Conceptually:

```ts
type InvestigationProgram = Effect.Effect<
  InvestigationContext,
  InvestigationError,
  | IssueSourceService
  | EvidenceSourcesService
  | CaseStoreService
  | KnowledgeMapService
  | SearchPolicyService
  | RuntimeAdapterService
>;
```

Effect is an implementation boundary, not a requirement for ordinary users.
The public programmatic API returns Promises, and third-party provider contracts
remain based on standard TypeScript, Promises, `AsyncIterable`, web APIs, and
`AbortSignal`. Tracecause adapts these contracts into Effects and Streams
internally. First-party providers may use Effect behind the portable provider
interface.

Tracecause continues to use:

- Zod for public, configuration, provider-neutral, and persisted schemas.
- `citty` for CLI parsing.
- `bun:test` as the initial test runner.
- Oxlint for static linting.
- Oxfmt for deterministic formatting.
- tsup for published ESM bundles.

Effect Schema and `@effect/cli` are not part of the initial architecture.
Adopting them later requires a specific demonstrated benefit and must not break
the public contracts or persisted schema format.

---

## 7. Monorepo structure

```text
tracecause/
├── apps/
│   └── cli/
├── packages/
│   ├── core/
│   ├── contracts/
│   ├── config/
│   ├── case-store/
│   ├── evidence/
│   ├── entities/
│   ├── knowledge-map/
│   ├── source-resolver/
│   ├── search-planner/
│   ├── investigation/
│   ├── context-builder/
│   ├── repository-context/
│   ├── redaction/
│   ├── reporter/
│   ├── provider-sentry/
│   ├── provider-cloudflare-workers/
│   ├── provider-cloudwatch-logs/
│   └── test-fixtures/
├── examples/
│   ├── cloudflare-worker/
│   └── node-api/
├── docs/
├── package.json
├── tsconfig.base.json
└── bun.lock
```

For the first release, only the root `tracecause` package needs to be public. Internal packages may remain private workspace packages and be bundled into the CLI.

The root `package.json` defines the Bun workspace. Bun is used for dependency
management, scripts, and tests, but production code must not depend on
Bun-specific APIs.

### Package responsibilities

#### `contracts`

Versioned provider-neutral types and schemas.

#### `core`

Public configuration API and programmatic `investigate()` API.

#### `case-store`

Atomic local persistence, schema migrations, case IDs, and case loading.

#### `evidence`

Normalization, provenance, hashing, deduplication, and evidence references.

#### `entities`

Entity extraction, canonicalization, aliases, sensitivity, and relationships.

#### `knowledge-map`

Versioned repository-scoped structural knowledge, local observations,
confidence updates, promotion, validation, expiry, and planner-facing lookups.

#### `source-resolver`

Resolution of Sentry projects, Cloudflare accounts, Worker services,
environments, telemetry datasets, and repository paths using explicit
configuration, learned knowledge, and current evidence.

#### `search-planner`

Search frontier, candidate scoring, query budgets, stop rules, and source selection.

#### `investigation`

The end-to-end orchestration loop.

#### `context-builder`

Timeline, facts, hypotheses, gaps, and agent-facing context generation.

#### `repository-context`

Local stack-frame resolution and focused source-file references.

#### `redaction`

Secret and personal-data redaction before persistence or agent output.

#### `reporter`

Terminal, Markdown, JSON, and NDJSON output.

#### `provider-sentry`

Initial issue-source adapter.

#### `provider-cloudflare-workers`

Initial evidence-source adapter.

#### `provider-cloudwatch-logs`

AWS CloudWatch Logs Insights evidence-source adapter with bounded log-group
selection, SigV4 request signing, query polling, wide-event normalization, and
structured entity extraction.

---

## 8. Core contracts

All public contracts must be runtime validated with Zod. Persisted schemas require explicit version numbers.

### 8.1 Plugin descriptor

```ts
export interface PluginDescriptor {
  id: string;
  displayName: string;
  version: string;
}
```

### 8.1.1 Provider context

```ts
export interface ProviderContext {
  caseId: string;
  signal: AbortSignal;
  logger: ProviderLogger;
}
```

When an Effect fiber running a provider operation is interrupted, Tracecause
must abort this signal. Provider implementations must pass it through to
network requests and stop producing evidence promptly. The provider logger
must apply Tracecause's secret-safe logging rules.

### 8.2 Issue source

```ts
export interface IssueSource {
  descriptor: PluginDescriptor;

  canHandle(reference: string): boolean | Promise<boolean>;

  fetchIssue(
    input: FetchIssueInput,
    context: ProviderContext,
  ): Promise<NormalizedIssue>;

  validateConfiguration(): Promise<ValidationResult>;
}

export interface FetchIssueInput {
  reference: string;
}
```

The issue source is responsible for:

- Resolving its own URL or identifier format.
- Fetching the issue and one representative occurrence.
- Mapping provider data into normalized evidence.
- Extracting provider-specific entities it can identify confidently.
- Returning source references that can be inspected later.

### 8.3 Evidence source

```ts
export interface EvidenceSource {
  descriptor: PluginDescriptor;
  capabilities: EvidenceSourceCapabilities;

  supports(intent: SearchIntent): SupportResult;

  search(
    intent: SearchIntent,
    context: ProviderContext,
  ): AsyncIterable<NormalizedEvidence>;

  validateConfiguration(): Promise<ValidationResult>;
}
```

The portable provider contract deliberately does not expose Effect types.
Internally, Tracecause wraps provider operations as Effects and adapts evidence
iterables into Effect Streams so cancellation, timeouts, resource cleanup, and
typed failures are governed by the investigation runtime.

### 8.4 Evidence source capabilities

```ts
export interface EvidenceSourceCapabilities {
  sourceTypes: Array<"logs" | "traces" | "deployments" | "events">;
  searchableEntityKinds: string[];
  supportsExactMatch: boolean;
  supportsFullText: boolean;
  supportsStructuredFields: boolean;
  supportsPagination: boolean;
  maximumTimeRange?: Duration;
}
```

Entity kinds are open strings, not a closed enum. Examples:

```text
cloudflare.ray_id
trace.id
request.id
correlation.id
customer.id
user.id
project.id
order.id
job.id
release.id
service.name
route.name
```

### 8.5 Normalized issue

```ts
export interface NormalizedIssue {
  schemaVersion: "1";
  source: SourceReference;
  title: string;
  message?: string;
  severity?: string;
  occurredAt: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  environment?: string;
  release?: string;
  service?: string;
  stackFrames: StackFrame[];
  request?: NormalizedRequest;
  tags: Record<string, Primitive>;
  entities: Entity[];
  evidence: NormalizedEvidence[];
}
```

### 8.6 Normalized evidence

```ts
export interface NormalizedEvidence {
  schemaVersion: "1";
  id: string;
  source: SourceReference;
  sourceType: "issue" | "log" | "trace" | "deployment" | "event";
  timestamp: string;
  observedAt?: string;
  service?: string;
  level?: string;
  message?: string;
  attributes: Record<string, unknown>;
  entities: Entity[];
  fingerprint: string;
  redactions: RedactionRecord[];
}
```

### 8.7 Entity

```ts
export interface Entity {
  id: string;

  // Open namespaced identifier, e.g. `cloudflare.ray_id`.
  kind: string;

  role:
    | "correlation"
    | "subject"
    | "resource"
    | "deployment"
    | "service"
    | "location"
    | "custom";

  value: string;
  canonicalValue: string;
  displayValue?: string;

  sensitivity: "none" | "internal" | "personal" | "secret";

  confidence: number;
  discoveredFromEvidenceId: string;
  extractorId: string;
}
```

Rules:

- Secret entities must never be used as search pivots.
- Personal entities may be used only when policy permits.
- Canonical values are used for deduplication.
- Agent-facing output may mask values while preserving stable aliases.

### 8.8 Search intent

The core emits semantic search intents. Providers compile them into provider-specific queries.

```ts
export interface SearchIntent {
  id: string;
  sourceId: string;
  entity: EntityReference;
  timeRange: TimeRange;
  mode: "exact" | "related-history" | "full-text";
  limit: number;
  depth: number;
  reason: string;
  causedByEvidenceIds: string[];
}
```

Example:

```json
{
  "sourceId": "cloudflare-workers",
  "entity": {
    "kind": "cloudflare.ray_id",
    "value": "83f1d84d6d7a21ab"
  },
  "timeRange": {
    "from": "2026-07-29T00:37:18.219Z",
    "to": "2026-07-29T00:47:18.219Z"
  },
  "mode": "exact",
  "limit": 100,
  "depth": 0,
  "reason": "The source issue contains a high-specificity Cloudflare Ray ID.",
  "causedByEvidenceIds": ["ev_sentry_1"]
}
```

### 8.9 Search result metadata

```ts
export interface SearchExecution {
  intent: SearchIntent;
  providerQuerySummary: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed" | "skipped" | "budget-exhausted";
  recordsRead: number;
  recordsAccepted: number;
  bytesRead?: number;
  error?: SerializableError;
}
```

The raw provider query may contain sensitive values. Store a safe summary by default.

### 8.10 Investigation context

```ts
export interface InvestigationContext {
  schemaVersion: "1";
  caseId: string;
  createdAt: string;
  updatedAt: string;

  issue: NormalizedIssue;
  summary: IncidentSummary;
  timeline: TimelineEvent[];
  entities: EntitySummary[];
  relationships: EvidenceRelationship[];
  facts: Finding[];
  hypotheses: Hypothesis[];
  gaps: ContextGap[];
  repository: RepositoryContext;
  searches: SearchExecution[];
  evidenceReferences: EvidenceReference[];
  knowledge: InvestigationKnowledgeUsage;
  completion: CompletionSummary;
}
```

`InvestigationKnowledgeUsage` records which prior mappings influenced source
selection or search scoring, which new observations were made, and whether any
mapping was rejected as stale or contradicted. It must not contain credentials
or sensitive entity values.

---

## 9. Entity extraction

New searchable entities are the mechanism that drives recursive investigation.

### 9.1 Extraction layers

Entity extraction should occur in this order:

1. **Provider-native extraction**  
   The provider knows where structured IDs are located.

2. **User-configured field extraction**  
   The user maps application log fields to semantic entity kinds.

3. **Built-in exact-pattern extraction**  
   First-party plugins may recognize their own identifiers, such as a Cloudflare Ray ID.

4. **Generic structured-key extraction**  
   Configurable aliases such as `requestId`, `request_id`, and `correlationId`.

5. **Optional AI-assisted extraction**  
   A future feature. Any extracted value must appear verbatim in evidence; the model may classify a value but must not invent one.

### 9.2 Field extractor contract

```ts
export interface EntityExtractor {
  id: string;
  extract(input: EntityExtractionInput): EntityCandidate[];
}

export interface EntityCandidate {
  kind: string;
  role: Entity["role"];
  value: string;
  sensitivity: Entity["sensitivity"];
  confidence: number;
  location: EvidenceLocation;
}
```

### 9.3 Entity aliases

Different providers may refer to the same semantic ID using different field names.

Configuration should allow:

```ts
entityAliases: {
  "request.id": ["requestId", "request_id", "req.id"],
  "customer.id": ["customerId", "customer_id", "customer.id"],
}
```

Aliases affect extraction, not provider query syntax. Each evidence-source plugin maps entity kinds to its own searchable fields.

---

## 10. Dynamic investigation loop

### 10.1 Algorithm

```ts
async function investigate(reference: string): Promise<InvestigationContext> {
  const issue = await fetchIssue(reference);
  const caseState = createCase(issue);

  ingestEvidence(caseState, issue.evidence);
  extractAndQueueEntities(caseState, issue);

  while (hasSearchBudget(caseState)) {
    const candidate = selectHighestValueSearch(caseState);

    if (!candidate) {
      break;
    }

    const result = await executeSearch(candidate);
    ingestEvidence(caseState, result.evidence);
    extractAndQueueEntities(caseState, result.evidence);
    updateRelationships(caseState);
  }

  resolveRepositoryContext(caseState);
  buildTimeline(caseState);
  deriveFactsAndGaps(caseState);

  return buildInvestigationContext(caseState);
}
```

This pseudocode describes behavior, not the concrete implementation style. The
implementation is an Effect program. The CLI and public Promise API provide and
run the required Effect layers at the application boundary. Expected failures
must use a typed `InvestigationError` hierarchy; defects remain distinguishable
from provider, configuration, policy, budget, persistence, and cancellation
errors.

### 10.2 Search frontier

Each candidate search is keyed by:

```text
source ID
+ entity kind
+ canonical entity value
+ time range
+ search mode
```

The same effective search must not execute twice.

### 10.3 Candidate scoring

A candidate score should consider:

```text
score =
  identifier specificity
  × extraction confidence
  × source support confidence
  × incident-time relevance
  × expected information gain
  × policy allowance
  - privacy cost
  - estimated query breadth
  - already-searched penalty
  - depth penalty
```

Recommended default specificity:

| Entity role/type                       | Relative value |
| -------------------------------------- | -------------: |
| Trace, Ray, request, correlation ID    |           1.00 |
| Event, job, payment, order, project ID |           0.85 |
| Customer, account, or user ID          |           0.65 |
| Release or deployment                  |           0.60 |
| Service and route                      |           0.35 |
| Error text or generic message          |           0.20 |

The exact weights are implementation details and should be configurable later.

### 10.4 Time-window policy

Default windows:

- Correlation identifiers: issue timestamp ±5 minutes.
- Resource identifiers: 30 minutes before the issue through 5 minutes after.
- Subject identifiers: 60 minutes before the issue through 5 minutes after.
- Releases and deployments: 24 hours before first occurrence through the issue.
- Full-text fallback: issue timestamp ±2 minutes.

The source's maximum supported range must always be respected.

### 10.5 Expansion example

```text
Depth 0
  Sentry issue
  └─ cloudflare.ray_id = 83f1d84d6d7a21ab

Depth 1
  Search Cloudflare logs by Ray ID
  ├─ request.id = req_8348a
  ├─ customer.id = cus_9182
  └─ project.id = prj_441

Depth 2
  Search customer.id in pre-incident window
  ├─ login succeeded
  ├─ project update requested
  └─ prior validation warning

  Search project.id in pre-incident window
  ├─ project imported
  └─ ownerId was absent

Depth 3
  Search request.id if not already covered
  └─ downstream request timeout

Result
  Assemble a causal-looking timeline while retaining evidence provenance.
```

### 10.6 Stop conditions

Stop when any of the following is true:

- Maximum query count reached.
- Maximum depth reached.
- Maximum evidence count reached.
- Maximum evidence byte limit reached.
- Wall-time budget reached.
- No unsearched candidate exceeds the minimum score.
- All configured evidence sources reject remaining candidates.
- Newly fetched evidence yields no new useful entities for two consecutive searches.
- User cancellation.

The completion summary must state which condition ended the investigation.

### 10.7 Source resolution and prior knowledge

Before expanding the search frontier, Tracecause should resolve the most likely
provider scope:

- Sentry organization, project, and environment.
- Cloudflare account, Worker service, and telemetry dataset.
- Repository checkout and relevant source root.

Resolution inputs, in descending order of authority, are:

1. Explicit user configuration.
2. Exact identifiers and current provider evidence.
3. Confirmed mappings from `.tracecause/knowledge.yaml`.
4. Repeated local observations from `.tracecause/state/observations.json`.
5. Agent-proposed or heuristic matches.

An exact Ray ID may be searched across the selected Cloudflare account in a
narrow time window before a Worker is known. A matching record can then
identify the Worker service and restrict later searches. When no exact
identifier exists, Tracecause ranks candidate Workers using request host,
route, Sentry project, environment, release, and prior confirmed mappings.

The chosen scope, confidence, rationale, and mappings used must be included in
the investigation audit trail. Ambiguous scope must be reported as a gap or
presented for user/agent selection; Tracecause must not silently search a broad
production scope.

---

## 11. Correlation and relationships

Tracecause should build an evidence graph, not merely concatenate log lines.

### 11.1 Node types

- Issue.
- Evidence record.
- Entity.
- Source file or stack frame.
- Search execution.

### 11.2 Relationship types

```text
issue_contains_entity
record_contains_entity
search_triggered_by_entity
search_returned_record
record_precedes_record
record_matches_stack_frame
record_mentions_release
entity_aliases_entity
```

### 11.3 Correlation confidence

Relationships should include confidence and rationale.

```ts
export interface EvidenceRelationship {
  id: string;
  from: NodeReference;
  to: NodeReference;
  type: string;
  confidence: number;
  rationale: string;
  supportingEvidenceIds: string[];
}
```

Shared customer IDs alone should not imply causation. The output must distinguish:

- Same identifier.
- Temporal proximity.
- Same request chain.
- Likely sequence.
- Proven causal relationship.

The MVP should generally stop at correlation and avoid asserting causation.

---

## 12. Timeline construction

Timeline events should be selected rather than dumping every matching log.

### 12.1 Selection factors

Prefer records that:

- Introduce a new entity.
- Represent a state transition.
- Contain warnings or errors.
- Occur close to the failure.
- Share a high-specificity correlation ID.
- Explain an action immediately before the failure.
- Contradict a current hypothesis.

### 12.2 Timeline event

```ts
export interface TimelineEvent {
  id: string;
  timestamp: string;
  service?: string;
  title: string;
  summary: string;
  evidenceIds: string[];
  entityIds: string[];
  confidence: number;
}
```

### 12.3 Repetition handling

Repeated equivalent logs should be grouped:

```text
00:41:52–00:42:10  Inventory lookup retried 4 times
```

The underlying evidence references remain available in JSON.

---

## 13. Repository context

Repository inspection is useful but deliberately narrow in the MVP.

### 13.1 MVP behavior

Tracecause should:

- Detect the Git repository root.
- Read package metadata.
- Resolve stack-frame file paths where possible.
- Include focused line ranges around application stack frames.
- Identify the nearest relevant test files by naming convention.
- Record the current commit.
- Compare a Sentry release or commit SHA when directly available.

Tracecause should not attempt whole-repository semantic analysis in the MVP.

### 13.2 Repository output

```ts
export interface RepositoryContext {
  root?: string;
  currentCommit?: string;
  incidentCommit?: string;
  commitMatch?: "exact" | "different" | "unknown";
  relevantFiles: RelevantFile[];
  suggestedSearchTerms: string[];
}
```

Agent-facing Markdown should reference files and line ranges rather than copying excessive source into the context bundle.

---

## 14. Context output

### 14.1 `context.md` structure

```markdown
# Production Bug Investigation

## Problem

## What is known

## Timeline

## Evidence trail

## Relevant entities

## Relevant code

## Hypotheses

## Missing context

## Recommended next actions

## Investigation limits
```

### 14.2 Evidence citations

Every factual bullet should reference stable local evidence IDs:

```markdown
- The request first failed after a project update with `ownerId = null`.
  [evidence: ev_cf_019, ev_cf_020]
```

### 14.3 Agent instructions

The top of the agent format should include:

```text
Use direct evidence and deterministic facts as authoritative.
Treat hypotheses as unproven.
Do not expose masked values.
When proposing a root cause, cite the supporting evidence IDs.
```

### 14.4 Token budget

Default agent output target: no more than 8,000 tokens.

When context exceeds the target:

- Group repeated records.
- Prefer summaries with evidence references.
- Omit low-value attributes.
- Keep raw evidence in NDJSON rather than Markdown.
- Preserve all context gaps and contradictory evidence.

---

## 15. Redaction and security

### 15.1 Redaction stages

Redaction occurs:

1. Immediately after provider normalization.
2. Before local persistence.
3. Before terminal output.
4. Before agent-facing output.

### 15.2 Default redactions

- Authorization headers.
- Cookies and session tokens.
- API keys and bearer tokens.
- Password-like fields.
- Private keys.
- Email addresses.
- Phone numbers.
- IP addresses when not required for correlation.
- Payment-card-like values.

### 15.3 Stable aliases

Personal identifiers should be replaced with stable case-local aliases where possible:

```text
cus_9182 → customer_1
person@example.com → email_1
```

The same original value must map to the same alias within one case.

### 15.4 Raw evidence

Default:

```yaml
retainRawEvidence: false
```

If enabled, raw evidence must be stored separately, prominently marked sensitive, and excluded from agent-facing output.

### 15.5 Query policy

Policies must allow an organisation to prohibit searching by certain entity roles or kinds:

```yaml
search:
  denyEntityKinds:
    - network.ip
  requireApprovalForRoles:
    - subject
  maximumSubjectHistory: 60m
```

Interactive approval can be added after the initial non-interactive MVP. Initially, a denied search is skipped and recorded.

---

## 16. Provider implementation notes

### 16.1 Sentry issue source

The Sentry adapter should:

- Recognize Sentry issue URLs and configured issue IDs.
- Fetch issue metadata.
- Fetch a representative event.
- Normalize exception, stack frames, request, tags, contexts, breadcrumbs, release, environment, and timestamp.
- Extract structured correlation values from tags and contexts.
- Preserve Sentry event and issue IDs as source references.

The adapter should not directly query Cloudflare or know which evidence sources are configured.

### 16.2 Cloudflare Workers evidence source

The Cloudflare adapter should:

- Compile supported semantic `SearchIntent` objects into Cloudflare telemetry queries.
- Search by Ray ID when mapped or natively available.
- Search by configured structured fields.
- Search by exact full-text value as a fallback when policy permits.
- Restrict every query to an explicit time range.
- Normalize console logs, exceptions, invocation metadata, script name, outcome, CPU time, and wall time where available.
- Paginate within the investigation budget.
- Extract first-party Cloudflare entities.
- Run user-configured entity extractors against application fields.

It must not decide which entity should be investigated next. That belongs to the core planner.

---

## 17. CLI specification

### 17.1 Commands

MVP:

```text
tracecause init
tracecause auth login sentry
tracecause auth status sentry
tracecause auth logout sentry
tracecause auth login cloudflare
tracecause auth status cloudflare
tracecause auth logout cloudflare
tracecause investigate <issue-reference>
tracecause cases list
tracecause cases show <case-id>
tracecause knowledge show
tracecause knowledge promote
tracecause knowledge validate
tracecause knowledge forget <mapping-id>
tracecause config validate
```

### 17.2 Investigate flags

```text
--config <path>
--format terminal|agent|json|ndjson
--output <directory|stdout>
--max-queries <number>
--max-depth <number>
--max-wall-time <duration>
--no-repository
--retain-raw-evidence
--verbose
--quiet
```

### 17.3 Exit codes

```text
0  Investigation completed, even if context is incomplete
1  Invalid CLI usage
2  Configuration error
3  Issue source could not fetch the issue
4  All evidence sources failed
5  Persistence or output failure
130 User cancellation
```

Partial evidence-source failures should normally produce exit code `0` with explicit gaps and warnings.

### 17.4 Programmatic API

```ts
import { investigate, loadConfig } from "tracecause";

const config = await loadConfig();
const result = await investigate({
  reference: sentryUrl,
  config,
});

console.log(result.context.caseId);
```

### 17.5 Runtime compatibility

The package is ESM-only and must support current stable releases of Bun, Node.js,
and Deno.

Expected invocation forms:

```bash
npx tracecause investigate <issue-reference>
bunx tracecause investigate <issue-reference>
deno run -A npm:tracecause investigate <issue-reference>
```

The published executable may use a Node shebang for npm and `npx`
compatibility, but the exported CLI entry and core API must remain callable
from Bun and Deno.

Production code should prefer runtime-neutral web APIs such as `fetch`, `URL`,
`AbortSignal`, `ReadableStream`, and Web Crypto. Runtime-specific operations,
including filesystem access, environment variables, process signals, and
terminal output, must be isolated behind small adapters. Bun-specific APIs may
be used by development scripts and tests, but not by the published core.

Effect must not obscure this portability boundary. Runtime-specific
implementations are provided as Effect services behind the runtime adapters;
core investigation code must not import Bun-, Node-, or Deno-specific APIs.
The bundled public API translates Effect exits into documented Promise results
or errors rather than exposing Effect runtime objects.

The initial CLI library is `citty`. If compatibility testing shows that it
cannot meet the Bun, Node.js, and Deno contract, it may be replaced without
changing the core investigation API.

---

## 18. Persistence

### 18.1 Case IDs

Use Nano ID with a product prefix:

```text
tc_V1StGXR8_Z5jdHi6
```

Case IDs do not need to be lexicographically sortable; case listings sort by
the persisted `createdAt` timestamp.

An external issue ID must not be used as the case ID. Provider identifiers and
the original issue reference are retained as source metadata because different
providers may have colliding identifiers, one issue may have multiple
investigations, and external identifiers may be unsafe or sensitive as local
path names.

### 18.2 Atomic writes

Case updates must be written atomically so interruption does not corrupt prior state.

### 18.3 Resume support

Not required for the first implementation, but persisted state should permit:

```bash
npx tracecause investigate --resume tc_V1StGXR8_Z5jdHi6
```

The deduplication key for prior searches must be persisted.

### 18.4 Schema migrations

Every persisted top-level document requires `schemaVersion`. Readers must either migrate old versions or fail with a clear message.

---

## 19. Observability of Tracecause itself

Verbose mode should show:

- Candidate entities discovered.
- Candidate search scores.
- Search selected and why.
- Provider execution duration.
- Records returned, accepted, and deduplicated.
- Evidence and byte budgets.
- Stop reason.

Tracecause's own structured diagnostic log should never contain provider tokens or unredacted secrets.

---

## 20. Investigation knowledge map

Tracecause maintains a repository-scoped map of how issue sources, production
services, telemetry fields, entity kinds, and source code relate. This lets
future investigations start with better source selection and higher-value
searches without retaining production evidence.

### 20.1 Storage layers

```text
.tracecause/
├── knowledge.yaml
└── state/
    └── observations.json
```

`knowledge.yaml` contains reviewed, non-sensitive structural mappings and is
intended to be committed. `state/observations.json` contains machine-generated
local observations and is gitignored.

Authentication credentials are stored outside the repository through the
credential-store abstraction. Case evidence remains in the gitignored
`.tracecause/cases/` directory.

### 20.2 Learnable structure

The knowledge map may record:

- Sentry project and environment to Cloudflare account and Worker service.
- Request hostname or route to Worker service.
- Sentry tag or context paths to semantic entity kinds.
- Cloudflare structured fields to semantic entity kinds.
- Worker service to available telemetry datasets and searchable fields.
- Release identifiers to repository commits.
- Stack-frame prefixes to local source directories.
- Search modes and time windows that repeatedly produce useful evidence.
- Structural relationships such as a Ray ID field revealing a request ID
  field.

It must not record:

- Customer, user, project, request, job, or other production entity values.
- Raw or normalized log records.
- Request or response payloads.
- Credentials or authentication metadata.
- Emails, IP addresses, tokens, or other personal or secret values.
- Free-form messages unless reduced to a reviewed, non-sensitive structural
  pattern.

### 20.3 Mapping contract

Each learned mapping requires:

```ts
export interface KnowledgeNode {
  type: string;
  key: string;
}

export interface KnowledgeProvenance {
  caseId: string;
  observationType: string;
}

export interface KnowledgeMapping {
  schemaVersion: "1";
  id: string;
  kind: string;
  from: KnowledgeNode;
  to: KnowledgeNode;
  confidence: number;
  confirmationCount: number;
  firstObservedAt: string;
  lastConfirmedAt: string;
  provenance: KnowledgeProvenance[];
  status: "observed" | "confirmed" | "stale" | "contradicted";
}
```

Provenance references case-local structural observations and must not copy
sensitive evidence into the knowledge store.

### 20.4 Learning lifecycle

1. Observe a possible structural mapping during an investigation.
2. Sanitize it and write it to local observations with low confidence.
3. Increase confidence when independent cases confirm the same mapping.
4. Mark contradictions explicitly rather than overwriting history.
5. Use sufficiently confident observations only as a scoring hint.
6. Promote reviewed mappings into `knowledge.yaml`.
7. Revalidate or decay mappings that have not been confirmed recently.

Learned knowledge can influence source ranking, entity extraction, and search
candidate scoring. It must never bypass provider capability checks, redaction,
query policy, approval rules, or investigation budgets.

Agent-proposed mappings are hypotheses until supported by direct evidence or
deterministic repository inspection. They must not be learned solely because a
model asserted them.

### 20.5 Example

```yaml
schemaVersion: "1"

services:
  api:
    sentryProjects: [api]
    cloudflareServices: [api-production]
    environments: [production]
    requestHosts: [api.example.com]
    repositoryPaths: [apps/api]

entityFields:
  cloudflare.ray_id:
    sentryPaths:
      - tags.cloudflare_ray_id
      - contexts.cloudflare.ray_id
    cloudflarePaths:
      - $metadata.rayId

mappings:
  - id: km_api_worker
    kind: service.correspondence
    from:
      type: sentry.project
      key: api
    to:
      type: cloudflare.service
      key: api-production
    confidence: 0.98
    confirmationCount: 14
    firstObservedAt: 2026-06-03T01:00:00Z
    lastConfirmedAt: 2026-07-29T02:00:00Z
    provenance:
      - caseId: tc_example
        observationType: exact_service_match
    status: confirmed
```

---

## 21. Testing strategy

### 21.1 Contract tests

Every provider must pass a shared contract suite covering:

- Configuration validation.
- Query support decisions.
- Pagination.
- Time-range enforcement.
- Normalization.
- Redaction boundaries.
- Error mapping.
- Cancellation.

The same suite must run providers through Tracecause's Effect adapter to verify
that interruption closes iterators and resources, retries follow provider
policy, timeouts are enforced, and typed failures retain their provider-safe
details.

### 21.2 Investigation fixtures

Create deterministic fixtures for:

1. Issue contains Ray ID → logs reveal customer ID.
2. Ray ID returns no logs → request ID succeeds.
3. Customer search yields unrelated records that must be rejected.
4. Duplicate IDs occur across multiple evidence records.
5. Sensitive values are extracted but prohibited as pivots.
6. Query budget ends before frontier exhaustion.
7. One provider fails while another succeeds.
8. Logs contain malformed structured payloads.
9. Timeline contains repeated retry logs.
10. Stack frame resolves to a local TypeScript file.

### 21.3 Provider fakes

Provider tests should use recorded, redacted fixtures and local fake HTTP
servers. CI must not require live Sentry, Cloudflare, or AWS credentials.

### 21.4 Property tests

Useful invariants:

- A search key executes at most once.
- No evidence fact loses its source reference.
- Secret entities never enter the search frontier.
- Redaction is idempotent.
- Evidence fingerprints are stable.
- Adding duplicate evidence does not change the final context.
- Investigation always terminates under finite budgets.
- Sensitive or instance-specific entity values never enter the knowledge map.
- Unconfirmed agent-proposed mappings never become confirmed knowledge.
- Learned mappings can change candidate ranking but cannot bypass policy or
  budgets.
- Contradictory observations reduce confidence or mark a mapping contradicted;
  they never silently replace provenance.
- Interrupting the investigation interrupts active provider searches and
  releases all scoped resources.
- Expected provider and persistence failures remain in the typed error channel
  and are not converted into defects.

### 21.5 End-to-end example

The example application should emit:

- A Cloudflare Ray ID.
- A request ID.
- A customer ID.
- A project ID.
- An intentional production-shaped error.
- Earlier events that explain the state leading to the failure.

A fixture Sentry response and fixture Cloudflare telemetry dataset should produce a deterministic `context.md` snapshot.

### 21.6 Runtime compatibility tests

The default unit and integration test runner is `bun:test`. Vitest should be
introduced only if a concrete testing requirement cannot be met with
`bun:test`.

CI must build the package with tsup and smoke-test the published artifacts on:

- Bun current stable.
- Node.js current LTS.
- Deno current stable using its npm package compatibility.

The smoke test must exercise the bundled CLI rather than importing TypeScript
source directly.

---

## 22. MVP milestones

### Milestone 1 — CLI and contracts

- TypeScript monorepo.
- Bun workspace and lockfile.
- ESM-only source and package exports.
- Effect v4 beta internal runtime and application layers.
- Oxlint and Oxfmt checks.
- `tracecause` executable.
- `citty` command structure.
- Sentry OAuth device-flow login, status, logout, refresh, and credential
  storage abstraction.
- Cloudflare OAuth authorization-code-with-PKCE login, status, logout, refresh,
  account selection, and token fallback.
- Config loader.
- Zod runtime schemas.
- Local case store.
- Provider contract test harness.
- Effect provider adapters, typed error hierarchy, scoped cancellation, and
  deterministic test layers.
- tsup library and CLI builds.

**Acceptance criteria:**

```bash
npx tracecause --help
npx tracecause init
npx tracecause auth login sentry
npx tracecause auth status sentry
npx tracecause auth login cloudflare
npx tracecause auth status cloudflare
npx tracecause config validate
```

work in a clean fixture project.

The equivalent `bunx` commands and the Deno npm-package invocation must pass
the published-artifact smoke tests.

### Milestone 2 — Sentry seed issue

- Sentry URL parsing.
- Issue and representative event retrieval.
- Normalized issue schema.
- Initial entity extraction.
- Sanitized persisted case.

**Acceptance criteria:** A fixture Sentry issue creates a case with error, timestamp, stack frames, release, request metadata, and seed entities.

### Milestone 3 — Cloudflare exact correlation

- Cloudflare Workers provider.
- Provider-neutral search intents.
- Ray ID and request ID searches.
- Evidence normalization and deduplication.
- Query audit log.

**Acceptance criteria:** A Ray ID extracted from the issue retrieves the matching fixture logs without Cloudflare-specific logic in the core.

### Milestone 4 — Recursive pivoting

- Search frontier.
- Entity scoring.
- User-configured entity fields.
- Customer and resource history searches.
- Query budgets and stop rules.
- Source resolution.
- Local structural observations.
- Reviewed investigation knowledge map.
- Knowledge inspection, validation, promotion, and forgetting commands.

**Acceptance criteria:** The fixture investigation follows Ray ID → customer ID → project ID and terminates deterministically.

A second fixture investigation should reuse a confirmed Sentry-project to
Worker-service mapping, search a narrower scope, and record which knowledge
influenced the plan. No fixture entity value may be written to
`knowledge.yaml` or local observations.

### Milestone 4.1 — CloudWatch evidence

- CloudWatch Logs Insights evidence source.
- Runtime-neutral AWS Signature Version 4 signing.
- Explicit log-group allowlist.
- Bounded query construction and polling.
- Structured wide-event normalization and entity extraction.
- Standard AWS credential-chain support for local profiles, IAM Identity
  Center, workload identity, instance roles, and environment credentials.

**Acceptance criteria:** A request ID extracted from a Sentry issue queries only
the configured CloudWatch log groups, produces normalized evidence, discovers
new entity IDs, redacts personal values, and can be cancelled through the
provider `AbortSignal`.

### Milestone 5 — Context bundle

- Timeline selection and grouping.
- Facts, hypotheses, and gaps.
- Agent Markdown.
- JSON context.
- Repository stack-frame resolution.

**Acceptance criteria:** The final context explains the relevant sequence without requiring the user to manually inspect all matching logs.

### Milestone 6 — Publishable MVP

- Bundled public npm package.
- `npx tracecause investigate` smoke test.
- README and example.
- Security documentation.
- Provider author guide.
- CI release workflow with npm provenance when practical.

---

## 23. MVP acceptance criteria

The MVP is complete when all of the following are true:

1. It is implemented in TypeScript.
2. It runs as `npx tracecause investigate <issue-reference>`.
3. The core contains no Sentry, Cloudflare, or CloudWatch query syntax.
4. A Sentry issue is normalized through an `IssueSource` implementation.
5. Cloudflare logs are queried through an `EvidenceSource` implementation.
6. A Ray ID in the issue can trigger a log search.
7. A customer or resource ID discovered in those logs can trigger a second bounded search.
8. Every search records what triggered it and why.
9. Equivalent searches are deduplicated.
10. Investigation terminates according to explicit budgets.
11. Evidence is redacted before agent-facing persistence.
12. The result contains a useful timeline rather than a raw log dump.
13. Facts cite evidence IDs.
14. Hypotheses are visibly labelled.
15. Missing context is explicit.
16. The output can be consumed by a coding agent without giving the agent direct provider credentials.
17. A new evidence provider can be added without changing the investigation loop.
18. The full fixture investigation is deterministic and covered by an end-to-end test.
19. Published ESM artifacts pass CLI smoke tests on Bun, Node.js, and Deno.
20. Tracecause records sanitized structural observations and can reuse confirmed
    mappings to improve later source selection and search ranking.
21. Machine-learned observations are gitignored, while promotion to the shared
    knowledge map is explicit and reviewable.
22. The knowledge map contains no production entity values, raw evidence, or
    credentials.
23. Every use of prior knowledge is recorded with confidence and rationale in
    the investigation context.
24. The investigation engine uses pinned Effect v4 beta for typed errors,
    structured concurrency, cancellation, resource safety, scheduling, and
    internal service composition.
25. Public APIs and third-party provider contracts do not require consumers to
    use Effect.
26. CloudWatch Logs Insights can be queried through an `EvidenceSource`
    implementation without changing the investigation loop.

---

## 24. Future directions

After the investigate-only MVP proves useful, possible additions include:

### Additional context sources

- Distributed traces.
- Deployment history.
- Feature flag state.
- Metrics anomalies.
- Queue events.
- Database audit logs.
- GitHub pull requests and commits.

### Interactive investigation

- Ask Tracecause to expand a specific entity.
- Increase a search window.
- Exclude an unrelated event branch.
- Mark a relationship as relevant or irrelevant.
- Continue an existing case with a new source.

### AI-assisted planning

An optional model may rank pivots or summarize evidence. It must operate on redacted data and preserve the deterministic query audit trail.

### Reproduction and replay

A later investigation strategy may:

- Reconstruct a request.
- Build fixtures and dependency mocks.
- Start a local environment.
- Replay the request.
- Compare the local result with production evidence.

Replay should consume the same `InvestigationContext`; it must not become a competing evidence model.

### Regression tests and fixes

- Generate a failing regression test.
- Validate a candidate fix against the case.
- Produce a human-reviewed patch.

### Team collaboration

- Share encrypted context bundles.
- Attach context back to the source issue.
- Run investigations from issue webhooks.
- Track which gaps recur across incidents.

---

## 25. Naming and package plan

**Recommended working name:** Tracecause
**Recommended npm package:** `tracecause`
**CLI binary:** `tracecause`

Example:

```json
{
  "name": "tracecause",
  "type": "module",
  "bin": {
    "tracecause": "dist/cli.js"
  },
  "exports": {
    ".": "./dist/index.js",
    "./providers/sentry": "./dist/providers/sentry.js",
    "./providers/cloudflare-workers": "./dist/providers/cloudflare-workers.js"
  }
}
```

The workspace uses Bun for package management and scripts, `bun:test` for the
initial test suite, pinned Effect v4 beta for the internal application runtime,
`citty` for command parsing, Nano ID for case IDs, Zod for runtime validation,
Oxlint and Oxfmt for code quality, and tsup for the published bundles.

The name reflects the core behavior: Tracecause follows a path of evidence from one clue to the next.

Package-name availability must be rechecked against the public npm registry immediately before reserving or publishing it. Search indexes are not an authoritative lock and names may be claimed at any time.

---

## 26. First implementation slice

Build the smallest vertical path before creating every package abstraction:

```text
1. `tracecause investigate fixture:sentry-issue`
2. Normalize fixture issue.
3. Extract fixture Ray ID.
4. Build a semantic SearchIntent.
5. Query fake Cloudflare provider.
6. Normalize and deduplicate returned logs.
7. Extract customer ID.
8. Query fake provider for customer history.
9. Build a timeline.
10. Write context.md and context.json.
```

Only after the end-to-end fixture works should the fake providers be replaced with live Sentry and Cloudflare adapters.

This slice proves the central product loop:

```text
issue → clue → search → new clue → search → context
```
