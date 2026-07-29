import { Data } from "effect";

export class IssueFetchError extends Data.TaggedError("IssueFetchError")<{
  readonly reference: string;
  readonly cause: unknown;
}> {}

export class EvidenceSearchError extends Data.TaggedError("EvidenceSearchError")<{
  readonly sourceId: string;
  readonly intentId: string;
  readonly cause: unknown;
}> {}

export class CaseWriteError extends Data.TaggedError("CaseWriteError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class InitializationError extends Data.TaggedError("InitializationError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class ProviderContractError extends Data.TaggedError("ProviderContractError")<{
  readonly providerId: string;
  readonly contract: "issue" | "evidence";
  readonly cause: unknown;
}> {}

export type InvestigationError =
  | IssueFetchError
  | EvidenceSearchError
  | ProviderContractError;
