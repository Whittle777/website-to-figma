// Shared LOCAL credit ledger: an operator-asserted reservation record and
// project-budget ceiling (1000 credits). It is NOT a provider-enforced credit
// cap and gives NO pre-send guarantee: provider charges for actions,
// screenshots, threat scans or redirects are not published/known, so actual
// credits may exceed a reservation. An overrun is recorded and blocks all
// further paid requests until the operator resolves it.
//
// Purpose: make paid hosted requests fail closed and impossible to repeat
// silently. A paid attempt is persisted BEFORE the request is sent
// ("attempting") and its result or uncertainty AFTER ("succeeded" / "failed" /
// "ambiguous"). A crash between the two leaves an "attempting" entry that
// blocks every further paid run until the operator resolves it.
//
// Credits: entries reserve the OPERATOR-ASSERTED price per request (this tool
// publishes no price). Request-specific creditsUsed reported in a response is
// recorded when present; account-wide balance deltas are never used. An entry
// counts max(reserved, reported) unless the operator resolved it.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const LEDGER_CAP = 1000;
const MAX_LEDGER_BYTES = 2_000_000;
const MAX_ENTRIES = 5_000;

export class LedgerError extends Error {}

export type EntryStatus = "attempting" | "succeeded" | "failed" | "ambiguous" | "manual" | "prior";
export interface LedgerEntry {
  id: string;
  at: string;
  command: string;
  url: string | null;
  requestSha256: string | null;
  reserved: number;
  reportedCredits: number | null;
  status: EntryStatus;
  note: string;
  resolvedAt?: string;
  resolvedCredits?: number | null;
  continuationOf?: string;
  // provider-reported request credits exceeded the reservation
  overrun?: boolean;
  // multi-operation lifecycles (browser sandbox): each operation's attempt and
  // outcome, persisted before and after the operation
  ops?: { op: string; at: string; status: "attempting" | "ok" | "failed" | "ambiguous"; detail: string }[];
  // charge not yet verified from a documented source (e.g. GET /v2/team/credit-usage delta)
  chargeStatus?: "pending_reconciliation" | "reconciled";
}
export interface Ledger {
  schema: "website-to-figma/credit-ledger";
  schemaVersion: 1;
  capCredits: number;
  entries: LedgerEntry[];
}

const STATUSES: EntryStatus[] = ["attempting", "succeeded", "failed", "ambiguous", "manual", "prior"];
const nonNegInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
const clean = (s: string, n = 200) => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

export function parseLedger(text: string): Ledger {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new LedgerError("ledger: not valid JSON");
  }
  const l = j as Partial<Ledger>;
  if (l?.schema !== "website-to-figma/credit-ledger" || l.schemaVersion !== 1 || !Array.isArray(l.entries)) throw new LedgerError("ledger: expected website-to-figma/credit-ledger v1");
  if (!nonNegInt(l.capCredits) || (l.capCredits as number) > LEDGER_CAP) throw new LedgerError(`ledger: capCredits must be <= ${LEDGER_CAP}`);
  if (l.entries.length > MAX_ENTRIES) throw new LedgerError("ledger: too many entries");
  const ids = new Set<string>();
  for (const [i, e] of l.entries.entries()) {
    const ok =
      e && typeof e.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(e.id) && !ids.has(e.id) && typeof e.at === "string" && typeof e.command === "string" && nonNegInt(e.reserved) &&
      (e.reportedCredits === null || nonNegInt(e.reportedCredits)) && STATUSES.includes(e.status) && typeof e.note === "string" &&
      (e.url === null || typeof e.url === "string") && (e.requestSha256 === null || (typeof e.requestSha256 === "string" && /^[0-9a-f]{64}$/.test(e.requestSha256))) &&
      (e.resolvedCredits === undefined || e.resolvedCredits === null || nonNegInt(e.resolvedCredits)) && (e.overrun === undefined || typeof e.overrun === "boolean") && (e.chargeStatus === undefined || e.chargeStatus === "pending_reconciliation" || e.chargeStatus === "reconciled") &&
      (e.ops === undefined || (Array.isArray(e.ops) && e.ops.length <= 20 && e.ops.every((o) => o && typeof o.op === "string" && typeof o.at === "string" && ["attempting", "ok", "failed", "ambiguous"].includes(o.status) && typeof o.detail === "string")));
    if (!ok) throw new LedgerError(`ledger: entries[${i}] is malformed`);
    ids.add(e.id);
  }
  return l as Ledger;
}

// Credits counted against the cap for one entry.
export function entryCredits(e: LedgerEntry): number {
  if (e.resolvedAt && typeof e.resolvedCredits === "number") return e.resolvedCredits;
  return Math.max(e.reserved, e.reportedCredits ?? 0);
}

export function committedCredits(l: Ledger): number {
  return l.entries.reduce((n, e) => n + entryCredits(e), 0);
}

// Entries that block new paid runs until the operator resolves them: a
// crash-left "attempting" entry, an "ambiguous" one (outcome or credits
// unknown), or a credit overrun.
export function unresolved(l: Ledger): LedgerEntry[] {
  return l.entries.filter((e) => (e.status === "attempting" || e.status === "ambiguous" || e.overrun === true || e.chargeStatus === "pending_reconciliation") && !e.resolvedAt);
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Regular file only (never a symlink), owner-only permissions enforced on write.
function assertRegular(path: string) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new LedgerError(`ledger ${path} does not exist (create it with: ledger init --ledger FILE --prior-credits N --note TEXT)`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new LedgerError(`ledger ${path} must be a regular file (symlinks refused)`);
}

export function readLedger(path: string): Ledger {
  assertRegular(path);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_LEDGER_BYTES) throw new LedgerError("ledger: file too large");
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return parseLedger(buf.subarray(0, off).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(path: string, l: Ledger) {
  assertRegular(path);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeSync(fd, JSON.stringify(l, null, 2) + "\n");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// Exclusive lock (O_EXCL lock file). A stale lock after a crash must be
// removed by the operator after checking no other run is active.
export function withLedgerLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch {
    throw new LedgerError(`ledger is locked (${lock}); another run may be active. Remove the lock only after confirming none is.`);
  }
  try {
    writeSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function initLedger(path: string, priorCredits: number, note: string, now: () => Date = () => new Date()): Ledger {
  if (!nonNegInt(priorCredits) || priorCredits > LEDGER_CAP) throw new LedgerError(`--prior-credits must be 0..${LEDGER_CAP}`);
  let exists = true;
  try {
    lstatSync(path);
  } catch {
    exists = false;
  }
  if (exists) throw new LedgerError(`ledger ${path} already exists; not overwritten`);
  const l: Ledger = { schema: "website-to-figma/credit-ledger", schemaVersion: 1, capCredits: LEDGER_CAP, entries: [] };
  if (priorCredits > 0) {
    l.entries.push({ id: randomUUID(), at: now().toISOString(), command: "prior", url: null, requestSha256: null, reserved: priorCredits, reportedCredits: priorCredits, status: "prior", note: clean(note || "operator-attributed prior project spend") });
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeSync(fd, JSON.stringify(l, null, 2) + "\n");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return l;
}

export interface Reservation {
  url: string;
  requestSha256: string;
  reserved: number;
  command: string;
  continuationOf?: string;
}

// Persist a paid attempt BEFORE the request. Refuses when the cap would be
// exceeded, any entry is unresolved, or the identical request was already
// attempted (unless the operator names that entry as a reviewed continuation).
export function reserveAttempt(path: string, r: Reservation, now: () => Date = () => new Date()): LedgerEntry {
  return withLedgerLock(path, () => {
    const l = readLedger(path);
    const open = unresolved(l);
    if (open.length) throw new LedgerError(`ledger has ${open.length} unresolved paid attempt(s) (${open.map((e) => e.id).join(", ")}); resolve them with "ledger resolve" before any new paid request`);
    const prior = l.entries.filter((e) => e.requestSha256 === r.requestSha256);
    if (prior.length && !(r.continuationOf && prior.some((e) => e.id === r.continuationOf))) {
      throw new LedgerError(`identical request ${r.requestSha256.slice(0, 16)}... was already attempted (entry ${prior.map((e) => e.id).join(", ")}); no automatic repeat. Re-run only after review with --reviewed-continuation <entry id>`);
    }
    const committed = committedCredits(l);
    if (committed + r.reserved > l.capCredits) throw new LedgerError(`project budget ceiling: ${committed} committed + ${r.reserved} reserved would exceed ${l.capCredits} credits (local allowance, not a provider cap)`);
    const e: LedgerEntry = { id: randomUUID(), at: now().toISOString(), command: r.command, url: r.url, requestSha256: r.requestSha256, reserved: r.reserved, reportedCredits: null, status: "attempting", note: "paid attempt recorded before sending; result pending", ...(r.continuationOf ? { continuationOf: r.continuationOf } : {}) };
    l.entries.push(e);
    writeAtomic(path, l);
    return e;
  });
}

// Record the result or uncertainty AFTER the request. Never settles at an
// assumed price: without request-specific credits the entry stays ambiguous
// (reservation counted) until the operator resolves it.
export function settleAttempt(path: string, id: string, status: "succeeded" | "failed" | "ambiguous", reportedCredits: number | null, note: string): LedgerEntry {
  return withLedgerLock(path, () => {
    const l = readLedger(path);
    const e = l.entries.find((x) => x.id === id);
    if (!e || e.status !== "attempting") throw new LedgerError(`ledger entry ${id} is not an open attempt`);
    e.reportedCredits = reportedCredits !== null && nonNegInt(reportedCredits) ? reportedCredits : null;
    e.status = status === "succeeded" && e.reportedCredits === null ? "ambiguous" : status;
    if (e.reportedCredits !== null && e.reportedCredits > e.reserved) e.overrun = true;
    e.note = clean(note);
    writeAtomic(path, l);
    return e;
  });
}

// Persist one lifecycle operation step on an open entry (before and after each op).
export function recordOp(path: string, id: string, op: { op: string; status: "attempting" | "ok" | "failed" | "ambiguous"; detail: string }, now: () => Date = () => new Date()): void {
  withLedgerLock(path, () => {
    const l = readLedger(path);
    const e = l.entries.find((x) => x.id === id);
    if (!e) throw new LedgerError(`ledger entry ${id} not found`);
    const ops = e.ops ?? [];
    if (ops.length >= 20) throw new LedgerError(`ledger entry ${id} has too many operation records`);
    ops.push({ op: clean(op.op, 40), at: now().toISOString(), status: op.status, detail: clean(op.detail) });
    e.ops = ops;
    writeAtomic(path, l);
  });
}

// Lifecycle finished, but its charge is NOT verified: no documented
// per-request charge exists, so the entry keeps its reservation counted and
// stays pending (blocking new paid runs) until reconciled from a documented
// account source. Never settles at an assumed or undocumented amount.
export function settlePendingReconciliation(path: string, id: string, note: string): LedgerEntry {
  return withLedgerLock(path, () => {
    const l = readLedger(path);
    const e = l.entries.find((x) => x.id === id);
    if (!e || e.status !== "attempting") throw new LedgerError(`ledger entry ${id} is not an open attempt`);
    e.status = "succeeded";
    e.reportedCredits = null;
    e.chargeStatus = "pending_reconciliation";
    e.note = clean(note);
    writeAtomic(path, l);
    return e;
  });
}

// Operator resolution of an attempting/ambiguous entry after manual review.
export function resolveEntry(path: string, id: string, credits: number | null, note: string, now: () => Date = () => new Date()): LedgerEntry {
  return withLedgerLock(path, () => {
    const l = readLedger(path);
    const e = l.entries.find((x) => x.id === id);
    if (!e) throw new LedgerError(`no ledger entry ${id}`);
    if (e.status !== "attempting" && e.status !== "ambiguous" && e.status !== "failed" && !e.overrun && e.chargeStatus !== "pending_reconciliation") throw new LedgerError(`entry ${id} (${e.status}) does not need resolution`);
    if (credits !== null && !nonNegInt(credits)) throw new LedgerError("--credits must be a whole number or unknown");
    // reconciliation needs a documented figure (credit-usage delta or dashboard), never "unknown"
    if (credits === null && e.chargeStatus === "pending_reconciliation") throw new LedgerError(`entry ${id} is pending reconciliation: pass the actual --credits N from GET /v2/team/credit-usage or the dashboard`);
    e.resolvedAt = now().toISOString();
    // unknown keeps the reservation counted
    e.resolvedCredits = credits === null ? Math.max(e.reserved, e.reportedCredits ?? 0) : credits;
    if (e.chargeStatus === "pending_reconciliation") e.chargeStatus = "reconciled";
    e.note = clean(`${e.note}; operator resolution: ${note || "reviewed"}${credits === null ? " (credits unknown; reservation kept)" : ""}`);
    writeAtomic(path, l);
    return e;
  });
}

// Manual entry for other attributable project spend (e.g. a crawl run).
export function recordManual(path: string, credits: number, note: string, now: () => Date = () => new Date()): LedgerEntry {
  return withLedgerLock(path, () => {
    const l = readLedger(path);
    if (!nonNegInt(credits) || credits < 1) throw new LedgerError("--credits must be a positive whole number");
    if (committedCredits(l) + credits > l.capCredits) throw new LedgerError(`recording ${credits} would exceed the ${l.capCredits}-credit project budget ceiling (local allowance); refused`);
    const e: LedgerEntry = { id: randomUUID(), at: now().toISOString(), command: "manual", url: null, requestSha256: null, reserved: credits, reportedCredits: credits, status: "manual", note: clean(note || "manual entry") };
    l.entries.push(e);
    writeAtomic(path, l);
    return e;
  });
}

export function ledgerSummary(l: Ledger): string {
  const committed = committedCredits(l);
  const open = unresolved(l);
  return [`Local project budget ceiling ${l.capCredits} (operator-asserted allowance; NOT a provider cap); committed ${committed}; remaining allowance ${l.capCredits - committed}; entries ${l.entries.length}; unresolved ${open.length}`, ...l.entries.slice(-20).map((e) => `  ${e.id} ${e.status}${e.overrun ? " OVERRUN" : ""}${e.chargeStatus ? ` ${e.chargeStatus.toUpperCase()}` : ""}${e.resolvedAt ? " (resolved)" : ""} reserved ${e.reserved} reported ${e.reportedCredits ?? "-"} counted ${entryCredits(e)} ${e.url ?? ""} ${e.note}`)].join("\n");
}
