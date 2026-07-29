# Tracecause

Be first on your team to turn a production bug into a detailed root cause and a fix.

Tracecause is an evidence-driven incident investigation CLI. Give it a Sentry
issue and it follows correlation IDs through your logs, discovers the affected
customers and resources, reconstructs the timeline, and writes a focused case
bundle for you or your coding agent.

Instead of manually jumping between an error tracker and several log searches,
you get the evidence, facts, gaps, and exact query trail needed to start fixing
the bug.

## What it does

Tracecause performs a bounded investigation:

```text
Sentry issue
  → extract Ray ID, request ID, trace ID, and known entities
  → search Cloudflare Workers or AWS CloudWatch logs
  → discover customer, project, job, and other entity IDs
  → search their preceding history
  → normalize, deduplicate, and redact evidence
  → build an evidence-linked timeline and context bundle
```

Every search records what triggered it and why. Facts retain evidence
references, hypotheses stay visibly separate, and missing context remains
explicit.

## Quick start

Authenticate, then investigate a real Sentry issue:

```bash
npx tracecause auth login sentry
npx tracecause investigate \
  "https://sentry.io/organizations/<organization-slug>/issues/<issue-id>/"
```

This creates a case under `.tracecause/cases/<case-id>/`, including:

- `context.md` — compact investigation context for a human or coding agent
- `context.json` — complete normalized context
- `evidence.ndjson` — sanitized evidence records
- `queries.ndjson` — the query audit trail

## Sign in locally

For local Sentry investigations, authenticate once instead of exporting a token
for every shell:

```bash
npx tracecause auth login sentry
npx tracecause auth status sentry
```

Tracecause displays Sentry's verification URL and device code, then stores the
result outside the repository in a user-only credential file. Environment
credentials still take precedence, which keeps CI deterministic.

## Investigate with Cloudflare Workers logs

Authenticate with Sentry first, then configure Cloudflare:

```bash
npx tracecause auth login sentry

export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."

npx tracecause investigate \
  "https://sentry.io/organizations/<organization-slug>/issues/<issue-id>/"
```

The Cloudflare token needs access to Workers Observability telemetry for the
selected account. `tracecause auth login cloudflare` is the intended local flow,
but it cannot ship until Tracecause's public Cloudflare OAuth application is
registered. The token variables are therefore still required for Cloudflare in
the current alpha.

## Investigate with AWS CloudWatch Logs

Tracecause uses the standard AWS credential chain. For local development, use
your existing AWS CLI profile or IAM Identity Center session:

```bash
npx tracecause auth login sentry

aws configure sso --profile my-company # first-time profile setup
aws sso login --profile my-company

export AWS_PROFILE="my-company"
export AWS_REGION="ap-southeast-2"
export TRACECAUSE_AWS_LOG_GROUPS="/aws/lambda/api,/aws/lambda/jobs"

npx tracecause investigate \
  "https://sentry.io/organizations/<organization-slug>/issues/<issue-id>/"
```

Existing profiles in `~/.aws/config` and `~/.aws/credentials` work too. In CI,
the same command automatically uses environment credentials, web identity,
ECS task credentials, or EC2 instance credentials—whichever the AWS credential
chain resolves first.

Use an IAM identity limited to these actions on the intended log groups:

```text
logs:StartQuery
logs:GetQueryResults
```

Tracecause signs requests with AWS Signature Version 4 using Web Crypto. It
does not persist AWS credentials or include them in case output.

## Use the result with an agent

Your agent can run Tracecause directly:

```bash
npx tracecause investigate "<sentry-issue-url>" --format agent
```

Or you can run it in your authenticated shell and give the agent only the
sanitized `.tracecause/cases/<case-id>/context.md` file. Provider credentials
stay inside the Tracecause process.

Environment credentials take precedence so the same commands work in CI.
Sentry device login is wired into the CLI. Cloudflare OAuth registration and
login remain in progress.

## Runtime and toolchain

- ESM-only TypeScript
- Bun for package management and tests
- Effect v4 beta for typed orchestration, cancellation, and provider boundaries
- Zod for public and external-data validation
- tsup for Bun, Node.js, and Deno-compatible output
- Oxlint and Oxfmt for code quality

## Status

Tracecause is in early development. Sentry issue ingestion, Cloudflare Workers
logs, CloudWatch Logs Insights, recursive evidence pivots, case persistence,
redaction, Sentry device login, and agent-oriented output are implemented.
Cloudflare OAuth, repository source resolution, and the persistent
investigation knowledge map remain planned.

See [SPEC.md](./SPEC.md) for the complete product and technical plan.
