// Bounded local file reads for operator inputs. Opens with O_NOFOLLOW (the
// final path component may not be a symlink), checks type and size on the
// OPEN descriptor (fstat, not a separate lstat), and never reads more than
// max+1 bytes, so a file swapped or grown after the check cannot exceed the
// bound. Optionally requires the resolved path to stay inside `root`.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { CaptureError } from "./convert";

export function readBoundedFile(path: string, max: number, root?: string): Uint8Array {
  const full = resolve(path);
  if (root) {
    // Resolve directory symlinks in the parent chain; the result must stay inside root.
    let parent: string;
    try {
      parent = realpathSync(dirname(full));
    } catch {
      throw new CaptureError("file not found");
    }
    if (parent !== root && !parent.startsWith(root + sep)) throw new CaptureError("file escapes the manifest directory");
  }
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new CaptureError(code === "ELOOP" ? "not a regular file (symlinks are refused)" : "file not found or unreadable");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CaptureError("not a regular file");
    if (st.size > max) throw new CaptureError(`larger than ${max} bytes`);
    const buf = new Uint8Array(Math.min(st.size, max) + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > max) throw new CaptureError(`larger than ${max} bytes`);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function readBoundedJson(path: string, max: number, what: string): unknown {
  const bytes = readBoundedFile(path, max);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CaptureError(`${what}: not valid UTF-8 JSON`);
  }
}
