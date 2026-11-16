import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachMemoryGuard,
  describeMemoryKill,
  judgeSample,
  parsePsSample,
  parseWindowsSample,
  treeBytes,
  windowsHelperScript,
  type MemoryGuardReason,
  type ProcessRow,
} from "./memory-guard.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function row(pid: number, ppid: number, mib: number, created = 0): ProcessRow {
  return { pid, ppid, bytes: mib * MIB, created };
}

describe("treeBytes", () => {
  it("sums the root and every descendant, nothing else", () => {
    const rows = [row(1, 0, 999), row(10, 1, 100), row(11, 10, 200), row(12, 11, 300), row(20, 1, 50)];
    expect(treeBytes(rows, 10)).toBe(600 * MIB);
  });

  it("is 0 when the root is gone", () => {
    expect(treeBytes([row(11, 10, 200)], 10)).toBe(0);
  });

  it("skips a 'child' older than its parent (a reused pid)", () => {
    // pid 10 was reused by a new process at t=500; 11 belonged to the old 10.
    const rows = [row(10, 1, 100, 500), row(11, 10, 4000, 100), row(12, 10, 50, 600)];
    expect(treeBytes(rows, 10)).toBe(150 * MIB);
  });

  it("survives a parent cycle", () => {
    const rows = [row(10, 11, 100), row(11, 10, 100)];
    expect(treeBytes(rows, 10)).toBe(200 * MIB);
  });
});

describe("judgeSample", () => {
  const base = { limitBytes: 8 * GIB, commitFreeBytes: 20 * GIB, commitTotalBytes: 60 * GIB };

  it("fires 'limit' over the tree limit", () => {
    expect(judgeSample({ ...base, treeBytes: 8 * GIB + 1 })).toBe("limit");
    expect(judgeSample({ ...base, treeBytes: 8 * GIB })).toBeNull();
  });

  it("fires 'commit' when free commit is under 5 % and the tree holds 1 GiB", () => {
    // 5 % of 60 GiB = 3 GiB > the 2 GiB minimum.
    const low = { ...base, commitFreeBytes: 2.9 * GIB };
    expect(judgeSample({ ...low, treeBytes: 1 * GIB })).toBe("commit");
    expect(judgeSample({ ...low, treeBytes: 1 * GIB - 1 })).toBeNull();
    expect(judgeSample({ ...base, commitFreeBytes: 3.1 * GIB, treeBytes: 2 * GIB })).toBeNull();
  });

  it("uses the 2 GiB minimum on a small machine", () => {
    const small = { limitBytes: 8 * GIB, commitTotalBytes: 16 * GIB, treeBytes: 1.5 * GIB };
    expect(judgeSample({ ...small, commitFreeBytes: 1.9 * GIB })).toBe("commit");
    expect(judgeSample({ ...small, commitFreeBytes: 2.1 * GIB })).toBeNull();
  });

  it("has no commit trigger without commit figures", () => {
    expect(
      judgeSample({ limitBytes: 8 * GIB, commitFreeBytes: null, commitTotalBytes: null, treeBytes: 7 * GIB }),
    ).toBeNull();
  });
});

describe("sample parsers", () => {
  it("reads the Windows helper's S and P lines and skips junk", () => {
    const sample = parseWindowsSample([
      "S 2000 60000",
      "P 10 1 4096 133000000000000000",
      "P bad 1 4096 0",
      "noise",
      "P 11 10 1024 0",
    ]);
    expect(sample.commitFreeBytes).toBe(2000);
    expect(sample.commitTotalBytes).toBe(60000);
    expect(sample.processes).toEqual([
      { pid: 10, ppid: 1, bytes: 4096, created: 133000000000000000 },
      { pid: 11, ppid: 10, bytes: 1024, created: 0 },
    ]);
  });

  it("has no commit figures without an S line", () => {
    expect(parseWindowsSample(["P 10 1 5 0"]).commitTotalBytes).toBeNull();
  });

  it("reads ps rss in KiB", () => {
    const sample = parsePsSample("  10     1  2048\n  11    10   512\n\n");
    expect(sample.processes).toEqual([
      { pid: 10, ppid: 1, bytes: 2048 * 1024, created: 0 },
      { pid: 11, ppid: 10, bytes: 512 * 1024, created: 0 },
    ]);
    expect(sample.commitFreeBytes).toBeNull();
  });
});

describe("windowsHelperScript", () => {
  it("is one line without double quotes and interpolates only integers", () => {
    const script = windowsHelperScript(4242.7, 50);
    expect(script).not.toMatch(/["\n]/);
    expect(script).toContain("Get-Process -Id 4242 ");
    // The interval is clamped so a bad config cannot spin the helper.
    expect(script).toContain("Start-Sleep -Milliseconds 100}");
  });
});

describe("describeMemoryKill", () => {
  it("names the limit or the machine, with the peak when known", () => {
    expect(describeMemoryKill("limit", 512 * MIB)).toBe(
      "this command's processes went over the memory limit at 512 MB — look for a loop that never ends or data that grows without bound",
    );
    expect(describeMemoryKill("commit", undefined)).toMatch(
      /^the machine was nearly out of memory while this command's processes held 1 GB or more — /,
    );
  });
});

/** A spawned helper whose stdout the test writes to. */
function fakeHelper() {
  const spawned: { file: string; args: readonly string[] }[] = [];
  let helper: (EventEmitter & { stdout: PassThrough; kill: () => boolean; unref: () => void; killed: number }) | undefined;
  const impl = ((file: string, args: readonly string[]) => {
    spawned.push({ file, args });
    const h = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      killed: 0,
      kill() {
        h.killed += 1;
        return true;
      },
      unref() {},
    });
    helper = h;
    return h;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawned, impl, current: () => helper };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("attachMemoryGuard on win32", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("starts the helper only after the delay and fires once over the limit", async () => {
    const fake = fakeHelper();
    const fired: [MemoryGuardReason, number][] = [];
    const guard = attachMemoryGuard(10, {
      limitBytes: 500 * MIB,
      onExceeded: (reason, bytes) => fired.push([reason, bytes]),
      platform: "win32",
      spawnImpl: fake.impl,
      startDelayMs: 1000,
    });
    vi.advanceTimersByTime(999);
    expect(fake.spawned).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fake.spawned[0]?.file).toBe("powershell.exe");

    const out = fake.current()!.stdout;
    out.write("S 30000000000 60000000000\r\nP 10 1 104857600 0\r\nP 11 10 1048");
    out.write("57600 0\r\nE\r\n");
    await flush();
    expect(guard.peakBytes()).toBe(200 * MIB);
    expect(fired).toEqual([]);

    out.write(`S 30000000000 60000000000\nP 10 1 ${400 * MIB} 0\nP 11 10 ${200 * MIB} 0\nE\n`);
    out.write(`S 30000000000 60000000000\nP 10 1 ${900 * MIB} 0\nE\n`);
    await flush();
    expect(fired).toEqual([["limit", 600 * MIB]]);
    expect(guard.hit()).toBe("limit");
    expect(fake.current()!.killed).toBe(1);
  });

  it("fires 'commit' when the machine runs low", async () => {
    const fake = fakeHelper();
    const fired: MemoryGuardReason[] = [];
    attachMemoryGuard(10, {
      limitBytes: 8 * GIB,
      onExceeded: (reason) => fired.push(reason),
      platform: "win32",
      spawnImpl: fake.impl,
      startDelayMs: 0,
    });
    vi.advanceTimersByTime(0);
    fake.current()!.stdout.write(`S ${1 * GIB} ${60 * GIB}\nP 10 1 ${2 * GIB} 0\nE\n`);
    await flush();
    expect(fired).toEqual(["commit"]);
  });

  it("stops sampling once the root has exited", async () => {
    const fake = fakeHelper();
    const guard = attachMemoryGuard(10, {
      limitBytes: 100 * MIB,
      onExceeded: () => {
        throw new Error("must not fire");
      },
      platform: "win32",
      spawnImpl: fake.impl,
      startDelayMs: 0,
    });
    vi.advanceTimersByTime(0);
    // An orphan the root left behind is not its tree any more.
    fake.current()!.stdout.write(`S ${30 * GIB} ${60 * GIB}
P 1 0 1 0
P 11 10 ${900 * MIB} 0
E
`);
    await flush();
    expect(fake.current()!.killed).toBe(1);
    expect(guard.hit()).toBeNull();
  });

  it("never starts when released before the delay", () => {
    const fake = fakeHelper();
    const guard = attachMemoryGuard(10, {
      limitBytes: 1,
      onExceeded: () => {},
      platform: "win32",
      spawnImpl: fake.impl,
    });
    guard.release();
    vi.advanceTimersByTime(10_000);
    expect(fake.spawned).toEqual([]);
  });

  it("fails open when the helper cannot be spawned", () => {
    const impl = (() => {
      throw new Error("EPERM");
    }) as unknown as typeof import("node:child_process").spawn;
    const guard = attachMemoryGuard(10, {
      limitBytes: 1,
      onExceeded: () => {
        throw new Error("must not fire");
      },
      platform: "win32",
      spawnImpl: impl,
      startDelayMs: 0,
    });
    vi.advanceTimersByTime(0);
    expect(guard.hit()).toBeNull();
  });

  it("does nothing without a root pid or with the limit off", () => {
    const fake = fakeHelper();
    for (const [pid, limit] of [[undefined, 100], [10, 0]] as const) {
      attachMemoryGuard(pid, {
        limitBytes: limit,
        onExceeded: () => {},
        platform: "win32",
        spawnImpl: fake.impl,
        startDelayMs: 0,
      });
    }
    vi.advanceTimersByTime(10_000);
    expect(fake.spawned).toEqual([]);
  });
});

describe("attachMemoryGuard on posix", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("polls ps and fires over the limit", () => {
    const outputs = ["10 1 1024\n11 10 1024\n", "10 1 1024\n11 10 999999\n"];
    const calls: string[][] = [];
    const execFileImpl = ((file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      calls.push([file, ...args]);
      cb(null, outputs.shift() ?? "");
      return new EventEmitter();
    }) as unknown as typeof import("node:child_process").execFile;
    const fired: [MemoryGuardReason, number][] = [];
    attachMemoryGuard(10, {
      limitBytes: 100 * MIB,
      onExceeded: (reason, bytes) => fired.push([reason, bytes]),
      platform: "linux",
      execFileImpl,
      startDelayMs: 0,
      intervalMs: 500,
    });
    vi.advanceTimersByTime(0);
    expect(calls).toEqual([["ps", "-A", "-o", "pid=,ppid=,rss="]]);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(fired).toEqual([["limit", (1024 + 999999) * 1024]]);
    vi.advanceTimersByTime(5_000);
    expect(calls).toHaveLength(2);
  });
});
