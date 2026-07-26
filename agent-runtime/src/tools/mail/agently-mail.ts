/**
 * agently-cli adapter: the Mail Worker's only way to touch a real mailbox.
 *
 * Every mutating call (send/reply/forward/trash) is wrapped in exactly one
 * CapabilityGateway.execute() per logical call, not per CLI invocation. The
 * Diplomacy Officer sees one ActionEnvelope describing the whole action
 * (its real recipient count as `externalAudience`) and decides once:
 *   - ALLOW / ALLOW_LOGGED: `operation()` runs, driving agently-cli's
 *     confirmation-token protocol end to end (phase 1 without a token, then
 *     phase 2 with it) -- both CLI calls happen with no further human step.
 *   - ELEVATE: CapabilityGateway throws ElevationRequiredError *before*
 *     `operation()` ever runs, so phase 1 never executes -- a bulk send
 *     never even asks agently-cli for a token until a human approves the
 *     pending elevation request.
 * That is the whole mail bulk-vs-single-send distinction (design doc 9.3):
 * it falls out of accurately describing each action to the existing
 * DiplomacyOfficer/CapabilityGateway, not from bulk-detection logic here.
 *
 * The CLI process is only ever spawned via an argv array
 * (SpawnAgentlyCliTransport below), never a shell string, and every message
 * field this module reads (subject, body, sender, attachment names) is
 * opaque data via ./mail-policy.js's normalizeMailData(), never an
 * instruction.
 *
 * watch() is a genuinely different shape from every other method: agently-cli
 * `message +watch` is a long-running long-poll process emitting one bare
 * NDJSON object per new-mail event indefinitely (verified against the real
 * installed `agently-cli`'s own `message +watch --print-output-schema`:
 * `{"message": {...}}` -- `message.message_id` required -- when
 * --msg-format=full, the default; `{"fetch_error": {...}}` when that
 * particular event's message details couldn't be fetched; "Empty long-poll
 * timeouts and transient network/server errors are retried silently" inside
 * the CLI itself, so a long gap with no stdout line is normal, not a stall).
 * That is fundamentally incompatible with AgentlyCliTransport's one-shot
 * request/response contract (spawn, collect all stdout, resolve once on
 * `close`) every other method uses -- so watch() gets its own spawner seam
 * (AgentlyCliWatchSpawner) and its own long-lived child process, framed with
 * the same JsonlDecoder (../../isolation/jsonl-decoder.js) RpcChamber uses
 * for `pi --mode rpc`'s NDJSON stdout.
 */

import { spawn } from "node:child_process";

import { ElevationRequiredError } from "../capability-gateway.js";
import type { ActionEnvelope } from "../diplomacy-officer.js";
import type { JsonlRecord } from "../../isolation/jsonl-decoder.js";
import { JsonlDecoder } from "../../isolation/jsonl-decoder.js";
import type { NormalizedMailData, RawMailMessage } from "./mail-policy.js";
import { normalizeMailData } from "./mail-policy.js";

const DEFAULT_ROLE_ID = "mail";
const DEFAULT_TASK_ID = "adhoc";

const EXIT_SUCCESS = 0;
const EXIT_RETRYABLE = new Set([1, 4]);
const EXIT_NOT_RETRYABLE = new Set([2, 3, 6]);
const EXIT_RATE_LIMITED = 7;
const EXIT_CONFIRMATION_REQUIRED = 8;

const DEFAULT_MAX_RETRIES = 2;

/** Structural seam CapabilityGateway satisfies as-is (mirrors DiplomacyEvaluator in ../capability-gateway.ts); tests may inject a real CapabilityGateway+DiplomacyOfficer pair or a narrower fake. */
export interface CapabilityGatewayLike {
  execute<T>(envelope: ActionEnvelope, operation: () => Promise<T>): Promise<T>;
}

/** One agently-cli JSON envelope error, e.g. `{"error": {"message": "...", "retry_after_ms": 1500}}`. */
export interface AgentlyCliErrorPayload {
  readonly message?: string;
  readonly retryAfterMs?: number;
}

/** The combination this adapter actually reasons about: the process's real exit code plus its parsed stdout JSON envelope. */
export interface AgentlyCliCall {
  readonly exitCode: number;
  readonly data?: Record<string, unknown>;
  readonly error?: AgentlyCliErrorPayload;
}

/** Seam between this module's retry/two-phase logic and however a call actually reaches agently-cli. Production uses SpawnAgentlyCliTransport; tests inject a queue-driven fake. */
export interface AgentlyCliTransport {
  run(args: readonly string[]): Promise<AgentlyCliCall>;
}

/** Thrown when agently-cli fails in a way that is not (or is no longer) retryable -- exit 2/3/6, or 1/4 with the retry budget exhausted. */
export class AgentlyCliError extends Error {
  readonly exitCode: number;
  readonly data: Record<string, unknown> | undefined;

  constructor(call: AgentlyCliCall) {
    super(call.error?.message ?? `agently-cli exited with code ${call.exitCode}`);
    this.name = "AgentlyCliError";
    this.exitCode = call.exitCode;
    this.data = call.data;
  }
}

/**
 * Reshaped ElevationRequiredError thrown at the mail.* boundary. Carries the
 * same requestId/target as the underlying CapabilityGateway error (useful
 * for a later approval flow) plus the `code: "ELEVATION_REQUIRED"` property
 * callers of this adapter match against.
 */
export class MailElevationRequiredError extends Error {
  readonly code = "ELEVATION_REQUIRED" as const;
  readonly requestId: string;
  readonly target: string;

  constructor(cause: ElevationRequiredError) {
    super(cause.message);
    this.name = "MailElevationRequiredError";
    this.requestId = cause.requestId;
    this.target = cause.target;
  }
}

function reshapeElevationError(error: unknown): unknown {
  return error instanceof ElevationRequiredError ? new MailElevationRequiredError(error) : error;
}

/** Real transport: spawns `agently-cli` with an argument array (never a shell string) and parses its stdout JSON envelope. Not exercised by this task's tests (they inject a fake AgentlyCliTransport); it's the real implementation production code constructs AgentlyMailClient with. */
export class SpawnAgentlyCliTransport implements AgentlyCliTransport {
  private readonly command: string;

  constructor(options: { readonly command?: string } = {}) {
    this.command = options.command ?? "agently-cli";
  }

  run(args: readonly string[]): Promise<AgentlyCliCall> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (exitCode) => {
        const envelope = parseEnvelope(stdout);
        resolve({ exitCode: exitCode ?? -1, data: envelope.data, error: envelope.error });
      });
    });
  }
}

/** Minimal structural slice of node:child_process's real ChildProcess this module's watch() depends on -- mirrors ../../isolation/rpc-chamber.ts's RpcChildProcess seam for the same reason: a real ChildProcess satisfies this as-is, tests inject a fake instead of spawning a real long-running `agently-cli` process. */
export interface AgentlyCliWatchProcess {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Builds the long-running `agently-cli message +watch` child process. Production uses createSpawnAgentlyCliWatchProcess(); tests inject a fake -- mirrors ../../isolation/rpc-chamber.ts's RpcProcessSpawner pattern. */
export type AgentlyCliWatchSpawner = () => AgentlyCliWatchProcess;

/** Production AgentlyCliWatchSpawner: spawns `agently-cli message +watch` via an argument array (never a shell string), streaming indefinitely until killed. Not exercised by this task's tests (they inject a fake spawner); it's the real implementation production code constructs AgentlyMailClient with. */
export function createSpawnAgentlyCliWatchProcess(command = "agently-cli"): AgentlyCliWatchSpawner {
  return (): AgentlyCliWatchProcess => spawn(command, ["message", "+watch"], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Reported via AgentlyMailClientOptions.onWatchError -- diagnostics only, never thrown back at a caller (there is no pending promise left to reject once watch() has already returned its handle). */
export class AgentlyCliWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentlyCliWatchError";
  }
}

function parseEnvelope(stdout: string): { data?: Record<string, unknown>; error?: AgentlyCliErrorPayload } {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      data?: Record<string, unknown>;
      error?: { message?: string; retry_after_ms?: number };
    };
    return {
      data: parsed.data,
      error: parsed.error
        ? { message: parsed.error.message, retryAfterMs: parsed.error.retry_after_ms }
        : undefined,
    };
  } catch {
    // Non-JSON (or partially-written) stdout: no parsed data/error, but the
    // exit code is still meaningful, and each operation's own result-mapping
    // throws a clear error if a required field ends up missing.
    return {};
  }
}

export interface MailActionContext {
  readonly taskId?: string;
  readonly roleId?: string;
}

export interface MailSendRequest {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly attachments?: readonly string[];
}

export interface MailReplyRequest {
  readonly messageId: string;
  readonly body: string;
  readonly replyAll?: boolean;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly attachments?: readonly string[];
}

export interface MailForwardRequest {
  readonly messageId: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly includeAttachments?: boolean;
  readonly attachments?: readonly string[];
}

export interface MailSearchRequest {
  readonly query: string;
  readonly folder?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly hasAttachments?: boolean;
  readonly isUnread?: boolean;
}

export interface MailDownloadRequest {
  readonly messageId: string;
  readonly attachmentId: string;
  readonly outputDir?: string;
}

export interface MailSendResult {
  readonly messageId: string;
}

export interface MailDownloadResult {
  readonly savedTo: string;
}

export interface MailWatchHandle {
  stop(): void;
}

export interface AgentlyMailClientOptions {
  readonly gateway: CapabilityGatewayLike;
  readonly transport?: AgentlyCliTransport;
  /** Injectable so tests never actually wait on an exit-7 rate limit backoff. Defaults to a real setTimeout-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Max retries for exit 1/4 ("service error"/"local network error"). Default 2, per the agently-cli exit-code contract. */
  readonly maxRetries?: number;
  /** Builds watch()'s long-running child process. Default: createSpawnAgentlyCliWatchProcess(). Inject a fake in tests -- separate from `transport` since watch()'s streaming contract is fundamentally different from every other method's one-shot request/response (see the module doc comment). */
  readonly watchSpawner?: AgentlyCliWatchSpawner;
  /** Diagnostics for watch(): called for a malformed NDJSON line, a `fetch_error` event, stderr output, or the watch process exiting/erroring unexpectedly. Never thrown -- there is no pending promise left to reject once watch() has already returned its handle. Default: no-op. */
  readonly onWatchError?: (error: AgentlyCliWatchError) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audienceOf(request: { to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[] }): number {
  return request.to.length + (request.cc?.length ?? 0) + (request.bcc?.length ?? 0);
}

function pushRepeated(args: string[], flag: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    args.push(flag, value);
  }
}

function sendArgs(request: MailSendRequest): string[] {
  const args = ["message", "+send"];
  pushRepeated(args, "--to", request.to);
  args.push("--subject", request.subject, "--body", request.body);
  pushRepeated(args, "--cc", request.cc);
  pushRepeated(args, "--bcc", request.bcc);
  pushRepeated(args, "--attachment", request.attachments);
  return args;
}

function replyArgs(request: MailReplyRequest): string[] {
  const args = ["message", "+reply", "--id", request.messageId, "--body", request.body];
  if (request.replyAll) {
    args.push("--reply-all");
  }
  pushRepeated(args, "--cc", request.cc);
  pushRepeated(args, "--bcc", request.bcc);
  pushRepeated(args, "--attachment", request.attachments);
  return args;
}

function forwardArgs(request: MailForwardRequest): string[] {
  const args = ["message", "+forward", "--id", request.messageId];
  pushRepeated(args, "--to", request.to);
  args.push("--body", request.body);
  pushRepeated(args, "--cc", request.cc);
  pushRepeated(args, "--bcc", request.bcc);
  if (request.includeAttachments) {
    args.push("--include-attachments");
  }
  pushRepeated(args, "--attachment", request.attachments);
  return args;
}

function searchArgs(request: MailSearchRequest): string[] {
  const args = ["message", "+search", "--q", request.query];
  if (request.folder !== undefined) {
    args.push("--dir", request.folder);
  }
  if (request.limit !== undefined) {
    args.push("--limit", String(request.limit));
  }
  if (request.cursor !== undefined) {
    args.push("--cursor", request.cursor);
  }
  if (request.hasAttachments) {
    args.push("--has-attachments");
  }
  if (request.isUnread) {
    args.push("--is-unread");
  }
  return args;
}

function readConfirmationToken(call: AgentlyCliCall): string {
  const token = call.data?.["confirmation_token"];
  if (typeof token !== "string" || token === "") {
    throw new Error("agently-cli returned exit code 8 without a confirmation_token");
  }
  return token;
}

function mapSendResult(call: AgentlyCliCall): MailSendResult {
  const messageId = call.data?.["message_id"];
  if (typeof messageId !== "string" || messageId === "") {
    throw new Error("agently-cli did not return a message_id");
  }
  return { messageId };
}

function asRawMailMessage(value: unknown): RawMailMessage {
  return value !== null && typeof value === "object" ? (value as RawMailMessage) : {};
}

function extractMessages(call: AgentlyCliCall): NormalizedMailData[] {
  const raw = call.data?.["messages"];
  return Array.isArray(raw) ? raw.map((entry) => normalizeMailData(asRawMailMessage(entry))) : [];
}

/** Mail Worker's tool surface: search/read/watch/send/reply/forward/trash/download, each wrapped in one CapabilityGateway.execute() call (see the module doc comment), with mutations driving agently-cli's confirmation-token protocol internally. */
export class AgentlyMailClient {
  private readonly gateway: CapabilityGatewayLike;
  private readonly transport: AgentlyCliTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly watchSpawner: AgentlyCliWatchSpawner;
  private readonly onWatchError: (error: AgentlyCliWatchError) => void;

  constructor(options: AgentlyMailClientOptions) {
    this.gateway = options.gateway;
    this.transport = options.transport ?? new SpawnAgentlyCliTransport();
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.watchSpawner = options.watchSpawner ?? createSpawnAgentlyCliWatchProcess();
    this.onWatchError = options.onWatchError ?? ((): void => {});
  }

  async search(request: MailSearchRequest, context?: MailActionContext): Promise<readonly NormalizedMailData[]> {
    const envelope = this.envelope("mail_search", `search "${request.query}"`, context);
    const call = await this.runThroughGateway(envelope, () => this.invoke(searchArgs(request)));
    return extractMessages(call);
  }

  async read(messageId: string, context?: MailActionContext): Promise<NormalizedMailData> {
    const envelope = this.envelope("mail_read", `read ${messageId}`, context);
    const call = await this.runThroughGateway(envelope, () => this.invoke(["message", "+read", "--id", messageId]));
    const raw = call.data?.["message"] ?? call.data;
    return normalizeMailData(asRawMailMessage(raw));
  }

  async download(request: MailDownloadRequest, context?: MailActionContext): Promise<MailDownloadResult> {
    const args = ["attachment", "+download", "--msg", request.messageId, "--att", request.attachmentId];
    if (request.outputDir !== undefined) {
      args.push("--output", request.outputDir);
    }
    const target = `download ${request.attachmentId} from ${request.messageId}`;
    const call = await this.runThroughGateway(this.envelope("mail_download", target, context), () => this.invoke(args));
    const savedTo = call.data?.["saved_to"];
    return { savedTo: typeof savedTo === "string" ? savedTo : "" };
  }

  /**
   * Real continuous streaming: spawns `agently-cli message +watch` once
   * (via watchSpawner, not `transport` -- see the module doc comment) and
   * keeps it running until stop() is called. `onMessage` fires once per
   * `{"message": {...}}` NDJSON line as it arrives; a `{"fetch_error": ...}`
   * line, a malformed line, or the process exiting/erroring unexpectedly
   * are all reported via `onWatchError`, never thrown (there is no pending
   * promise left to reject once this method has already returned its
   * handle) and never treated as a reason to stop -- the CLI documents
   * silently retrying transient errors on its own, so this adapter keeps
   * the child process running rather than assuming one bad line ends the
   * stream.
   */
  async watch(onMessage: (message: NormalizedMailData) => void, context?: MailActionContext): Promise<MailWatchHandle> {
    const envelope = this.envelope("mail_watch", "watch inbox", context);
    return this.runThroughGateway(envelope, async () => this.startWatchStream(onMessage));
  }

  private startWatchStream(onMessage: (message: NormalizedMailData) => void): MailWatchHandle {
    const child = this.watchSpawner();
    const decoder = new JsonlDecoder({
      onInvalidLine: (raw, error) => {
        this.onWatchError(new AgentlyCliWatchError(`malformed +watch line: ${String(error)}: ${raw}`));
      },
    });
    let stopped = false;

    child.stdout.on("data", (chunk) => {
      for (const record of decoder.push(chunk)) {
        this.handleWatchLine(record, onMessage);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text !== "") {
        this.onWatchError(new AgentlyCliWatchError(`+watch stderr: ${text}`));
      }
    });
    child.on("exit", (code, signal) => {
      if (!stopped) {
        this.onWatchError(new AgentlyCliWatchError(`+watch process exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
    child.on("error", (error) => {
      this.onWatchError(new AgentlyCliWatchError(`+watch process error: ${error.message}`));
    });

    return {
      stop: (): void => {
        if (!stopped) {
          stopped = true;
          child.kill();
        }
      },
    };
  }

  /** One `+watch` NDJSON line: `{"message": {...}}` (the common case) feeds onMessage; `{"fetch_error": ...}` or anything else missing `message` is reported via onWatchError and otherwise ignored -- see the module doc comment's real --print-output-schema quote. */
  private handleWatchLine(record: JsonlRecord, onMessage: (message: NormalizedMailData) => void): void {
    if ("message" in record) {
      onMessage(normalizeMailData(asRawMailMessage(record["message"])));
      return;
    }
    if ("fetch_error" in record) {
      const fetchError = record["fetch_error"];
      const message =
        fetchError !== null && typeof fetchError === "object" && "message" in fetchError
          ? String((fetchError as Record<string, unknown>)["message"])
          : "unknown fetch_error";
      this.onWatchError(new AgentlyCliWatchError(`+watch event fetch failed: ${message}`));
      return;
    }
    this.onWatchError(new AgentlyCliWatchError(`+watch line had neither "message" nor "fetch_error": ${JSON.stringify(record)}`));
  }

  async send(request: MailSendRequest, context?: MailActionContext): Promise<MailSendResult> {
    const audience = audienceOf(request);
    const envelope = this.envelope("mail_send", `send to ${request.to.length} recipient(s)`, context, {
      reversible: false,
      affectedObjects: Math.max(audience, 1),
      externalAudience: audience,
      operation: "send",
    });
    return this.runThroughGateway(envelope, () => this.performTwoPhase(sendArgs(request)).then(mapSendResult));
  }

  async reply(request: MailReplyRequest, context?: MailActionContext): Promise<MailSendResult> {
    // Original sender plus any explicit cc/bcc; reply-all's true fan-out
    // lives in the source thread, so a caller that needs it audience-checked
    // precisely should read() the thread first and pass cc/bcc explicitly.
    const audience = 1 + (request.cc?.length ?? 0) + (request.bcc?.length ?? 0);
    const envelope = this.envelope("mail_reply", `reply to ${request.messageId}`, context, {
      reversible: false,
      affectedObjects: Math.max(audience, 1),
      externalAudience: audience,
      operation: "send",
    });
    return this.runThroughGateway(envelope, () => this.performTwoPhase(replyArgs(request)).then(mapSendResult));
  }

  async forward(request: MailForwardRequest, context?: MailActionContext): Promise<MailSendResult> {
    const audience = audienceOf(request);
    const target = `forward ${request.messageId} to ${request.to.length} recipient(s)`;
    const envelope = this.envelope("mail_forward", target, context, {
      reversible: false,
      affectedObjects: Math.max(audience, 1),
      externalAudience: audience,
      operation: "send",
    });
    return this.runThroughGateway(envelope, () => this.performTwoPhase(forwardArgs(request)).then(mapSendResult));
  }

  async trash(messageId: string, context?: MailActionContext): Promise<void> {
    // Soft delete (agently-cli recovers trashed mail for 30 days): stays
    // reversible: true (the default), unlike the permanent bulk delete
    // (design doc 9.3) this adapter does not expose at all.
    const envelope = this.envelope("mail_trash", `trash ${messageId}`, context, { operation: "delete" });
    await this.runThroughGateway(envelope, () => this.performTwoPhase(["message", "+trash", "--id", messageId]));
  }

  /** Shared ActionEnvelope builder: every mail action is a plain, non-reversible-mutating read unless `overrides` says otherwise (send/reply/forward/trash pass one). */
  private envelope(
    toolName: string,
    targetSummary: string,
    context: MailActionContext | undefined,
    overrides: Partial<Pick<ActionEnvelope, "reversible" | "affectedObjects" | "externalAudience" | "operation">> = {},
  ): ActionEnvelope {
    return {
      taskId: context?.taskId ?? DEFAULT_TASK_ID,
      roleId: context?.roleId ?? DEFAULT_ROLE_ID,
      toolName,
      targetSummary,
      reversible: overrides.reversible ?? true,
      affectedObjects: overrides.affectedObjects ?? 1,
      externalAudience: overrides.externalAudience ?? 0,
      sensitiveData: false,
      threatensAvailability: false,
      operation: overrides.operation ?? "read",
    };
  }

  /** Runs `operation` and reshapes a CapabilityGateway ElevationRequiredError into MailElevationRequiredError -- see the module doc comment for why elevation is checked once per logical call, before any CLI phase runs. */
  private async runThroughGateway<T>(envelope: ActionEnvelope, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.gateway.execute(envelope, operation);
    } catch (error) {
      throw reshapeElevationError(error);
    }
  }

  /** Drives agently-cli's two-phase confirmation protocol: phase 1 without a token; if that comes back exit 8, phase 2 with the identical args plus `--confirmation-token <token>`. Only ever reached once diplomacy has already allowed the whole logical action (see runThroughGateway/the module doc comment). */
  private async performTwoPhase(args: readonly string[]): Promise<AgentlyCliCall> {
    const first = await this.invoke(args);
    if (first.exitCode !== EXIT_CONFIRMATION_REQUIRED) {
      return first;
    }
    const token = readConfirmationToken(first);
    return this.invoke([...args, "--confirmation-token", token]);
  }

  /** One logical CLI call, with the exit-code contract's retry rules applied: 1/4 retry up to maxRetries; 7 waits for Retry-After then retries unconditionally (a rate limit is throttling, not failure, so it does not consume the 1/4 budget); 2/3/6 (or an exhausted 1/4 budget) throw AgentlyCliError; 0/8 return directly to the caller (performTwoPhase / the read-shaped methods) to interpret. */
  private async invoke(args: readonly string[]): Promise<AgentlyCliCall> {
    let retries = 0;
    for (;;) {
      const call = await this.transport.run(args);

      if (call.exitCode === EXIT_SUCCESS || call.exitCode === EXIT_CONFIRMATION_REQUIRED) {
        return call;
      }

      if (call.exitCode === EXIT_RATE_LIMITED) {
        await this.sleep(call.error?.retryAfterMs ?? 0);
        continue;
      }

      if (EXIT_RETRYABLE.has(call.exitCode) && retries < this.maxRetries) {
        retries += 1;
        continue;
      }

      // Anything else fails closed: exit 2/3/6 (never retryable), exit 1/4
      // with the retry budget exhausted, or any exit code outside the
      // documented contract -- never treat an unrecognized code as success.
      throw new AgentlyCliError(call);
    }
  }
}
