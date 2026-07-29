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

Tracecause also learns non-sensitive structure between investigations. For
example, it can observe that a Sentry project corresponds to a Cloudflare
Worker service, then rank that provider first in later investigations after
you review and promote the mapping.

## Quick start

Authenticate, then investigate a real Sentry issue:

```bash
npx tracecause auth login sentry
npx tracecause investigate \
  "https://<organization-slug>.sentry.io/issues/<issue-id>/?query=is%3Aunresolved"
```

Keep Sentry URLs in quotes. Shells such as zsh interpret `?` as a wildcard and
`&` as a background-command operator before Tracecause can receive an unquoted
URL.

This creates a case under `.tracecause/cases/<case-id>/`, including:

- `context.md` — compact investigation context for a human or coding agent
- `context.json` — complete normalized context
- `evidence.ndjson` — sanitized evidence records
- `queries.ndjson` — the query audit trail

## Review learned structure

Investigations write sanitized structural observations to the gitignored
`.tracecause/state/observations.json`. They never write customer IDs, request
IDs, raw logs, payloads, or credentials to the knowledge map.

Review and promote useful mappings explicitly:

```bash
npx tracecause knowledge validate
npx tracecause knowledge show
npx tracecause knowledge promote
```

Promoted mappings are written to `.tracecause/knowledge.yaml`, which is safe to
review and commit. Later investigations can use confirmed mappings to rank
evidence providers; each use is recorded in `context.md` and `context.json`.
Remove an obsolete mapping with:

```bash
npx tracecause knowledge forget <mapping-id>
```

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

Authenticate once with Sentry and Cloudflare. Tracecause reuses Wrangler's OAuth
session, including automatic token refresh, so no Cloudflare token needs to be
copied into your shell or a `.env` file:

```bash
npx tracecause auth login sentry
npx wrangler login --use-keyring
npx tracecause auth status cloudflare

npx tracecause investigate \
  "https://<organization-slug>.sentry.io/issues/<issue-id>/?query=is%3Aunresolved"
```

Tracecause asks Wrangler for its current OAuth token using
`wrangler auth token --json`; it does not read or copy Wrangler's credential
files. If your login can access exactly one Cloudflare account, Tracecause
selects it automatically. For multiple accounts, set only the non-secret account
selection:

```bash
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
```

CI remains non-interactive. Set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the CI secret store; complete environment credentials
take precedence over Wrangler.

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
  "https://<organization-slug>.sentry.io/issues/<issue-id>/?query=is%3Aunresolved"
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
Sentry device login is wired into the CLI. Local Cloudflare authentication
reuses the OAuth session managed and refreshed by Wrangler.

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
redaction, local authentication, agent-oriented output, structural observation,
reviewed knowledge promotion, and knowledge-guided provider ranking are
implemented. Repository stack-frame resolution, user-defined entity fields,
and narrower knowledge-guided provider scopes remain planned.

See the [documentation index](./docs/README.md) for the implemented CLI,
authentication, providers, case format, knowledge workflow, and library API.
