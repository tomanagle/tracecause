# Cases, redaction, and knowledge

## Case directory

Successful persisted investigations create:

```text
.tracecause/cases/<case-id>/
├── context.md
├── context.json
├── timeline.json
├── entities.json
├── queries.ndjson
├── evidence.ndjson
└── metadata.json
```

- `context.md` is the compact human/agent handoff.
- `context.json` contains the complete normalized investigation context.
- `timeline.json` contains ordered non-issue evidence events.
- `entities.json` contains discovered entity summaries.
- `queries.ndjson` records each search intent, reason, timing, and counts.
- `evidence.ndjson` contains normalized, sanitized evidence.
- `metadata.json` contains case timestamps and the completion reason.

Writes use a temporary directory and atomic rename so an interrupted write does
not expose a partially completed case. Case directories are gitignored by
`tracecause init`.

## Redaction

Entities marked `personal` receive stable case-local aliases such as
`customer_1`. Their raw values are removed from persisted entities, searches,
and provider messages. Entities marked `secret` are not added to the recursive
search frontier.

Case output is designed to be safer to give to an agent, but Tracecause only
redacts entity values it successfully recognizes. Review output before sharing
it outside the environment.

## Local observations

After an investigation, Tracecause can derive non-sensitive structural
mappings such as:

```text
sentry.project api → cloudflare.service api-production
```

These are written to the gitignored:

```text
.tracecause/state/observations.json
```

Repeated independent cases increase the observation's confirmation count and
confidence. Case IDs are retained as provenance. Production customer, user,
project, request, and job values are not copied into observations.

## Reviewed knowledge

Use:

```bash
npx tracecause knowledge show
npx tracecause knowledge validate
npx tracecause knowledge promote
```

Promotion is the explicit review boundary. It moves all observations into:

```text
.tracecause/knowledge.yaml
```

Reviewed knowledge is intended to be committed with the repository. A confirmed
mapping can rank the matching evidence provider first during later
investigations. Every mapping that influences selection is recorded with its
confidence and rationale in the context bundle.

Current knowledge behavior does not narrow a Cloudflare Worker, telemetry
dataset, or CloudWatch log group. Contradiction detection, staleness, confidence
decay, and selective promotion are also not implemented.
