// Exclusive, owner-only output files for state runs. Never overwrites: a run
// directory must not exist yet, every file is created with O_EXCL|O_NOFOLLOW
// and mode 0600, and symlinked parents/targets are refused.
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class OutputError extends Error {}

export function createExclusiveDir(parent: string, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new OutputError("invalid output directory name");
  const root = resolve(parent);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OutputError(`${root} must be a real directory (symlinks refused)`);
  const dir = join(root, name);
  try {
    mkdirSync(dir, { mode: 0o700 }); // fails if it exists: never reuses or overwrites output
  } catch {
    throw new OutputError(`${dir} already exists; refusing to overwrite`);
  }
  return dir;
}

export function writeExclusive(path: string, data: string | Uint8Array): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch {
    throw new OutputError(`${path} already exists or is not writable; refusing to overwrite`);
  }
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
