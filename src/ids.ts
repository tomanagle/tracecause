import { createHash } from "node:crypto";
import { nanoid } from "nanoid";

export const createCaseId = (): string => `rc_${nanoid(16)}`;

export const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

const canonicalJson = (value: unknown): string => {
  if (value === undefined) {
    return '"[undefined]"';
  }
  if (typeof value === "bigint") {
    return JSON.stringify(`[bigint:${value.toString()}]`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
