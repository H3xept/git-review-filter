import type { FileChange } from "./core/diff";
import type { JevAnswers, JevState } from "./core/jev";

/** Messages the content script sends to the service worker. The API key never leaves the worker. */
export type Request =
  | { type: "diff:fetch"; repo: string; number: number }
  | { type: "jev:score"; state: JevState; digest: string; visibility: "public" | "private" }
  | { type: "jev:status" }
  | { type: "options:open" };

export interface DiffFile extends FileChange {
  /** SHA-256 of the file's complete diff chunk, so cached answers expire when any part of the change moves. */
  readonly digest: string;
}

export type DiffResponse =
  | { ok: true; visibility: "public" | "private"; files: DiffFile[] }
  | { ok: false; error: string };

export type ScoreResponse = { ok: true; answers: JevAnswers; model: string; cached: boolean } | { ok: false; error: string; retryable: boolean };

export interface StatusResponse {
  hasKey: boolean;
}

export interface ResponseFor {
  "diff:fetch": DiffResponse;
  "jev:score": ScoreResponse;
  "jev:status": StatusResponse;
  "options:open": null;
}

export function send<R extends Request>(request: R): Promise<ResponseFor[R["type"]]> {
  return chrome.runtime.sendMessage(request);
}
