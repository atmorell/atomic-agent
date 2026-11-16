import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * Watch the memory of a command's process tree and say when it must die.
 *
 * Model-written code can loop without end and allocate until the machine
 * runs out. On Windows that is worse than a slow command: once the
 * machine-wide commit charge reaches its limit, *every* process that asks
 * for memory fails — the agent, the local model server, the desktop — and
 * a `MemoryError` in an unrelated process is the first visible sign
 * (fusion run k8az, 16-11-2026: one pytest grew to 6.6 GB and commit hit
 * 98 %). A timeout does not help, because the damage is done long before it.
 *
 * Two triggers, judged once per sample by `judgeSample`:
 * - `limit`: the tree's private bytes are over the configured limit.
 * - `commit`: the machine's free commit is under
 *   max(2 GiB, 5 % of the commit limit) while the tree holds at least
 *   1 GiB — the tree is then a likely cause, and killing it is cheaper
 *   than letting every other process fail. Windows only; POSIX reports
 *   no commit figures here.
 *
 * Sampling. Node has no Win32 binding for process memory, so on Windows
 * one PowerShell helper per guard prints a sample every `intervalMs`
 * (`Win32_OperatingSystem` and `Win32_Process` through CIM, ~40 ms of
 * CPU per sample) and exits when the owner pid is gone or its stdout
 * pipe breaks. On POSIX each sample is one `ps -A -o pid=,ppid=,rss=`.
 * The helper is started only after `startDelayMs`, so a command that
 * ends quickly never pays for it.
 *
 * Fail open: a helper that cannot start, errors or exits leaves the
 * command running unguarded. The guard never kills anything itself; it
 * calls `onExceeded` once and stops sampling, and the caller kills the
 * tree it owns.
 *
 * `platform`, `spawnImpl` and `execFileImpl` are parameters so both
 * branches run under test on any host.
 */

export type MemoryGuardReason = "limit" | "commit";

export interface MemoryGuardOptions {
  /** Private bytes the tree may hold; must be > 0. */
  limitBytes: number;
  /** Called at most once, with the reason and the tree's bytes then. */
  onExceeded: (reason: MemoryGuardReason, treeBytes: number) => void;
  /** Time between samples. Default 1000 ms. */
  intervalMs?: number;
  /** Time before the first sample. Default 1500 ms. */
  startDelayMs?: number;
  /** The helper exits when this pid is gone. Default `process.pid`. */
  ownerPid?: number;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  execFileImpl?: typeof execFile;
}

export interface MemoryGuard {
  /** Stop sampling and end the helper; idempotent. */
  release(): void;
  /** Largest tree size seen, in bytes (0 before the first sample). */
  peakBytes(): number;
  /** Why the guard fired, or null. */
  hit(): MemoryGuardReason | null;
}

export const MEMORY_GUARD_INTERVAL_MS = 1_000;
export const MEMORY_GUARD_START_DELAY_MS = 1_500;
const GIB = 1024 ** 3;
/** Free commit below this (or 5 % of the limit, if larger) is critical. */
export const COMMIT_FLOOR_MIN_BYTES = 2 * GIB;
export const COMMIT_FLOOR_FRACTION = 0.05;
/** A tree smaller than this is never blamed for low commit. */
export const COMMIT_FLOOR_TREE_MIN_BYTES = 1 * GIB;

export interface ProcessRow {
  pid: number;
  ppid: number;
  bytes: number;
  /** Creation time in any monotonic unit; 0 when unknown. */
  created: number;
}

export interface MemorySample {
  /** Machine-wide free commit; null where the platform reports none. */
  commitFreeBytes: number | null;
  commitTotalBytes: number | null;
  processes: ProcessRow[];
}

/**
 * Sum the private bytes of `rootPid` and its descendants.
 *
 * Windows keeps a dead parent's pid in its children's ParentProcessId,
 * and pids are reused, so a row only counts as a child when it was
 * created no earlier than its parent; an unknown time (0) is trusted.
 */
export function treeBytes(processes: readonly ProcessRow[], rootPid: number): number {
  const byParent = new Map<number, ProcessRow[]>();
  let root: ProcessRow | undefined;
  for (const row of processes) {
    if (row.pid === rootPid) root = row;
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }
  if (!root) return 0;
  let total = 0;
  const seen = new Set<number>();
  const queue: ProcessRow[] = [root];
  while (queue.length > 0) {
    const row = queue.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    total += row.bytes;
    for (const child of byParent.get(row.pid) ?? []) {
      if (child.pid === row.pid) continue;
      if (child.created && row.created && child.created < row.created) continue;
      queue.push(child);
    }
  }
  return total;
}

export function judgeSample(input: {
  treeBytes: number;
  limitBytes: number;
  commitFreeBytes: number | null;
  commitTotalBytes: number | null;
}): MemoryGuardReason | null {
  if (input.limitBytes > 0 && input.treeBytes > input.limitBytes) return "limit";
  if (
    input.commitFreeBytes !== null &&
    input.commitTotalBytes !== null &&
    input.commitTotalBytes > 0 &&
    input.treeBytes >= COMMIT_FLOOR_TREE_MIN_BYTES
  ) {
    const floor = Math.max(
      COMMIT_FLOOR_MIN_BYTES,
      input.commitTotalBytes * COMMIT_FLOOR_FRACTION,
    );
    if (input.commitFreeBytes < floor) return "commit";
  }
  return null;
}

/**
 * Parse one Windows helper sample: `S <free> <total>`, then one
 * `P <pid> <ppid> <privateBytes> <created>` per process. Malformed lines
 * are skipped; a sample without an `S` line has no commit figures.
 */
export function parseWindowsSample(lines: readonly string[]): MemorySample {
  let commitFreeBytes: number | null = null;
  let commitTotalBytes: number | null = null;
  const processes: ProcessRow[] = [];
  for (const raw of lines) {
    const cols = raw.trim().split(/\s+/);
    if (cols[0] === "S" && cols.length >= 3) {
      const free = Number(cols[1]);
      const total = Number(cols[2]);
      if (Number.isFinite(free) && Number.isFinite(total) && total > 0) {
        commitFreeBytes = free;
        commitTotalBytes = total;
      }
    } else if (cols[0] === "P" && cols.length >= 5) {
      const row = toRow(cols[1], cols[2], cols[3], cols[4], 1);
      if (row) processes.push(row);
    }
  }
  return { commitFreeBytes, commitTotalBytes, processes };
}

/** Parse `ps -A -o pid=,ppid=,rss=` (rss in KiB). */
export function parsePsSample(stdout: string): MemorySample {
  const processes: ProcessRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const row = toRow(cols[0], cols[1], cols[2], "0", 1024);
    if (row) processes.push(row);
  }
  return { commitFreeBytes: null, commitTotalBytes: null, processes };
}

function toRow(
  pid: string | undefined,
  ppid: string | undefined,
  amount: string | undefined,
  created: string | undefined,
  unit: number,
): ProcessRow | null {
  const p = Number(pid);
  const pp = Number(ppid);
  const b = Number(amount);
  const c = Number(created);
  if (!Number.isInteger(p) || p <= 0 || !Number.isInteger(pp) || !Number.isFinite(b)) {
    return null;
  }
  return { pid: p, ppid: pp, bytes: Math.max(0, b) * unit, created: Number.isFinite(c) ? c : 0 };
}

/**
 * The PowerShell helper. One line, no double quotes, so it survives
 * Windows argument quoting as a single `-Command` argument. Only
 * validated integers are interpolated.
 */
export function windowsHelperScript(ownerPid: number, intervalMs: number): string {
  const owner = Math.trunc(ownerPid);
  const ms = Math.max(100, Math.trunc(intervalMs));
  return [
    "$ErrorActionPreference='Stop'",
    "$o=[Console]::Out",
    "while($true){" +
      `if(-not (Get-Process -Id ${owner} -ErrorAction SilentlyContinue)){break}` +
      ";$s=New-Object System.Text.StringBuilder" +
      ";try{" +
      "$os=Get-CimInstance -ClassName Win32_OperatingSystem -Property FreeVirtualMemory,TotalVirtualMemorySize" +
      ";[void]$s.Append('S ').Append([int64]$os.FreeVirtualMemory*1024).Append(' ').Append([int64]$os.TotalVirtualMemorySize*1024).Append([char]10)" +
      ";foreach($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,PrivatePageCount,CreationDate){" +
      "$c=0;if($p.CreationDate){$c=$p.CreationDate.ToFileTimeUtc()}" +
      ";[void]$s.Append('P ').Append($p.ProcessId).Append(' ').Append($p.ParentProcessId).Append(' ').Append([int64]$p.PrivatePageCount).Append(' ').Append($c).Append([char]10)" +
      "}" +
      "}catch{}" +
      ";[void]$s.Append('E').Append([char]10)" +
      ";$o.Write($s.ToString());$o.Flush()" +
      `;Start-Sleep -Milliseconds ${ms}` +
      "}",
  ].join(";");
}

/**
 * Why the guard killed a command, said to the model plainly, because
 * the cure is in the code: a loop or a structure that never stops
 * growing. Shared by `os.shell.run` and `verify.run`.
 */
export function describeMemoryKill(
  reason: MemoryGuardReason,
  peakBytes: number | undefined,
): string {
  const held =
    peakBytes === undefined || peakBytes <= 0
      ? ""
      : ` at ${Math.round(peakBytes / 1024 / 1024)} MB`;
  const why =
    reason === "commit"
      ? `the machine was nearly out of memory while this command's processes held${held || " 1 GB or more"}`
      : `this command's processes went over the memory limit${held}`;
  return `${why} — look for a loop that never ends or data that grows without bound`;
}

export function attachMemoryGuard(
  rootPid: number | undefined,
  options: MemoryGuardOptions,
): MemoryGuard {
  const platform = options.platform ?? process.platform;
  const intervalMs = options.intervalMs ?? MEMORY_GUARD_INTERVAL_MS;
  const startDelayMs = options.startDelayMs ?? MEMORY_GUARD_START_DELAY_MS;
  let released = false;
  let peak = 0;
  let reason: MemoryGuardReason | null = null;
  let startTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let helper: ChildProcess | undefined;

  const release = (): void => {
    if (released) return;
    released = true;
    if (startTimer) clearTimeout(startTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (helper) {
      try {
        helper.kill();
      } catch {
        // already gone
      }
    }
  };

  const onSample = (sample: MemorySample): void => {
    if (released || rootPid === undefined) return;
    if (
      sample.processes.length > 0 &&
      !sample.processes.some((row) => row.pid === rootPid)
    ) {
      // The root has exited; what it left behind is no longer its tree,
      // so there is nothing left to guard — stop sampling.
      release();
      return;
    }
    const bytes = treeBytes(sample.processes, rootPid);
    if (bytes > peak) peak = bytes;
    const verdict = judgeSample({
      treeBytes: bytes,
      limitBytes: options.limitBytes,
      commitFreeBytes: sample.commitFreeBytes,
      commitTotalBytes: sample.commitTotalBytes,
    });
    if (!verdict) return;
    reason = verdict;
    release();
    options.onExceeded(verdict, bytes);
  };

  const startWindows = (): void => {
    const spawnImpl = options.spawnImpl ?? spawn;
    try {
      helper = spawnImpl(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsHelperScript(options.ownerPid ?? process.pid, intervalMs),
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
    } catch {
      return; // fail open
    }
    helper.on("error", () => {});
    helper.unref();
    const out = helper.stdout;
    if (!out) return;
    (out as { unref?: () => void }).unref?.();
    let pending = "";
    let block: string[] = [];
    out.setEncoding("utf8");
    out.on("data", (chunk: string) => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (line === "E") {
          const lines = block;
          block = [];
          onSample(parseWindowsSample(lines));
        } else if (line) {
          block.push(line);
        }
        nl = pending.indexOf("\n");
      }
    });
  };

  const pollPosix = (): void => {
    if (released) return;
    const execFileImpl = options.execFileImpl ?? execFile;
    try {
      const child = execFileImpl(
        "ps",
        ["-A", "-o", "pid=,ppid=,rss="],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (released) return;
          if (!err) onSample(parsePsSample(String(stdout)));
          if (!released) {
            pollTimer = setTimeout(pollPosix, intervalMs);
            pollTimer.unref?.();
          }
        },
      );
      child.on?.("error", () => {});
    } catch {
      // fail open: no more samples
    }
  };

  if (rootPid !== undefined && options.limitBytes > 0) {
    startTimer = setTimeout(() => {
      startTimer = undefined;
      if (released) return;
      if (platform === "win32") startWindows();
      else pollPosix();
    }, startDelayMs);
    startTimer.unref?.();
  } else {
    released = true;
  }

  return { release, peakBytes: () => peak, hit: () => reason };
}
