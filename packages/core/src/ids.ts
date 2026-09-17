import { ulid } from "ulid";

export function newId(): string {
  return ulid();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function utcDateStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
