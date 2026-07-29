# Evidence providers

Tracecause separates issue retrieval from evidence search. Providers implement
portable Promise and `AsyncIterable` contracts; the investigation runtime wraps
them in Effect for typed failures and cancellation.

## Sentry issue source

Supported references include:

```text
https://sentry.io/organizations/<org>/issues/<id>/
https://<org>.sentry.io/issues/<id>/
<numeric-id>  # requires a configured organization
```

The provider retrieves the issue and recommended event. It normalizes:

- title and message;
- occurrence, first-seen, and last-seen timestamps;
- project/service and environment;
- release;
- in-application stack frames;
- request URL, method, and headers;
- tags, contexts, and exception details.

Known Sentry fields can produce Ray, request, trace, customer, user, project,
and job entities.

## Cloudflare Workers Observability

The Cloudflare provider calls:

```text
POST /accounts/<account-id>/workers/observability/telemetry/query
```

It sends an explicit time range, caps a search at 100 records, and searches for
the entity value as a non-regex needle. It normalizes telemetry events into the
shared evidence schema and extracts known structured entity fields.

Supported pivot kinds:

- `cloudflare.ray_id`
- `request.id`
- `trace.id`
- `customer.id`
- `user.id`
- `project.id`
- `job.id`

Personal entity values are replaced in persisted messages and entity summaries.
Confirmed service knowledge currently ranks this provider first when relevant;
it does not yet add a Worker-service filter to the telemetry query.

## AWS CloudWatch Logs Insights

CloudWatch searches only the log groups listed in
`TRACECAUSE_AWS_LOG_GROUPS`. Each query has an explicit time range and result
limit. Tracecause starts a Logs Insights query, polls every 500 milliseconds by
default, stops on terminal failure states, and responds to cancellation.

The provider normalizes JSON log messages and common Logs Insights fields. It
supports the same known entity kinds as Cloudflare plus generic correlation
identifiers recognized by the provider.

## Recursive investigation

The investigation starts with entities from the issue and prioritizes exact
correlation identifiers. Default windows are:

- Correlation identifiers: five minutes before to five minutes after.
- Resource entities: thirty minutes before to five minutes after.
- Subject entities: sixty minutes before to five minutes after.

New entities are added to a scored frontier. Equivalent searches and evidence
fingerprints are deduplicated. The investigation stops when the frontier is
exhausted or the query/depth budget is reached.

Only one supporting evidence provider is selected for each candidate. Confirmed
Sentry-project mappings can change provider order but cannot bypass provider
capabilities or budgets.
