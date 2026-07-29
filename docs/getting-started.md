# Getting started

## Requirements

- Bun, Node.js 20 or newer, or Deno with npm compatibility.
- Access to a Sentry organization.
- At least one evidence source:
  - Cloudflare Workers Observability; or
  - AWS CloudWatch Logs Insights.

Tracecause is published as the `tracecause` npm package and can be run without
a global installation:

```bash
npx tracecause --help
```

Equivalent `bunx tracecause` and `deno run -A npm:tracecause` invocations are
supported by the ESM build.

## Initialize a repository

Run this once from the repository root:

```bash
npx tracecause init
```

It creates:

```text
.tracecause/
├── .gitignore
├── config.ts
├── knowledge.yaml
├── policies.yaml
├── cases/
└── state/
    └── observations.json
```

Case data and local observations are gitignored. Reviewed
`knowledge.yaml` is intended to be committed. Initialization uses
create-only writes and does not overwrite existing files.

`config.ts` and `policies.yaml` are currently scaffolding: the CLI does not load
or enforce them yet. Runtime provider configuration comes from authentication,
environment variables, and CLI options.

## Authenticate

Sign in to Sentry:

```bash
npx tracecause auth login sentry
```

Then configure Cloudflare, CloudWatch, or both. See
[Authentication](./authentication.md).

## Investigate

Always quote a Sentry URL because shells interpret characters such as `?` and
`&`:

```bash
npx tracecause investigate \
  "https://<organization>.sentry.io/issues/<issue-id>/?query=is%3Aunresolved"
```

Tracecause retrieves the issue, extracts known correlation and entity IDs,
performs bounded recursive searches, redacts personal values, and writes a case
under:

```text
.tracecause/cases/<case-id>/
```

For machine-readable output without writing a case:

```bash
npx tracecause investigate "<sentry-url>" --format json --output stdout
```

For Markdown on stdout:

```bash
npx tracecause investigate "<sentry-url>" --format agent --output stdout
```

## Give the case to an agent

The compact handoff is:

```text
.tracecause/cases/<case-id>/context.md
```

It contains evidence-linked facts, the timeline, searches performed, relevant
entities, stack-frame references, knowledge used, gaps, and investigation
limits. Provider credentials are not included.
