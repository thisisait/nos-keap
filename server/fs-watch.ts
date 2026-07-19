/**
 * Filesystem watch — event-driven triggering for the fs-sync mirrors.
 *
 * The interval (KEAP_FS_SYNC_INTERVAL_S) makes a written file appear as a
 * knowledge object within minutes; this module makes it seconds. It is a
 * TRIGGER layer only: recursive fs.watch over the per-user tree
 * (KEAP_USER_FILES_DIR) and each mounted KEAP_FS_ROOTS path, debounced into
 * the EXISTING sync entrypoints — syncUserFiles() for the users tree,
 * syncMapping(m) for every enabled mapping under the touched root. The mirror
 * semantics (ids, skip keys, prune guards) live entirely in fs-sync.ts and
 * are frozen: a watcher changes WHEN a pass runs, never WHAT it does. The
 * passes are idempotent (size+mtime[+cfg] unchanged-skip), so the watcher
 * tracks no diffs — an over-broad or spurious event costs one cheap pass.
 *
 * Discipline:
 *   - never watch a non-existent root. Roots stay REGISTERED while unmounted
 *     (fs-roots doctrine); the re-probe interval (KEAP_FS_WATCH_REARM_S,
 *     default 30s) arms a watcher when a late mount appears — and schedules
 *     one pass for it, since files written before arming emit no events. A
 *     watched dir that vanishes (unmount) is disarmed the same way and
 *     re-armed when it returns.
 *   - debounce: a burst of events per root collapses into ONE pass, 2s after
 *     the last event (fixed — bursts must never turn into a pass per file).
 *   - symlinks are never followed: Node's recursive watch does not traverse
 *     directory symlinks, and whatever events do arrive only trigger passes
 *     whose walker enforces the realpath-containment rule itself.
 *   - degradation, not crash loops: recursive fs.watch is verified at runtime
 *     (Node >=20 supports it on macOS + Linux); an unsupported platform or a
 *     watcher-resource failure (EMFILE/ENOSPC) closes every watcher and logs
 *     ONE warning — the fs-sync interval keeps syncing, nothing retries.
 *   - watcher count is capped (one recursive watcher per root, MAX_WATCHERS
 *     roots) so a runaway KEAP_FS_ROOTS list cannot exhaust fd budgets.
 *
 * Kill-switch: KEAP_FS_WATCH=0 disables the module entirely (status then
 * reports enabled:false). Inert without any configured tree, like fs-sync.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import * as db from './db';
import { listRoots } from './fs-roots';
import {
  fsSyncInFlight,
  registerFsWatchStatus,
  syncMapping,
  syncUserFiles,
  USER_FILES_DIR,
  type FsWatchStatusBlock,
} from './fs-sync';

const ENABLED = process.env.KEAP_FS_WATCH !== '0';
/** Debounce is FIXED at 2s — an env-tunable value below the burst window
 *  would reintroduce the pass-per-file failure mode the debounce exists
 *  to prevent. */
const DEBOUNCE_MS = 2000;
/** Late-mount re-probe cadence (also detects vanished mounts). 0 disables. */
const REARM_S = Number(process.env.KEAP_FS_WATCH_REARM_S ?? 30);
/** One recursive watcher per root; a pathological roots list degrades the
 *  tail to interval-only instead of exhausting file descriptors. */
const MAX_WATCHERS = 32;

/** 'users' is a RESERVED root key (fs-roots.ts RESERVED_KEYS), so using it as
 *  the users-tree watch key can never collide with a mapping root. */
const USERS_KEY = 'users';

const watchers = new Map<string, { path: string; watcher: FSWatcher }>();
const pending = new Map<string, NodeJS.Timeout>();
let lastEvent: { at: string; root: string } | null = null;
let active = false; // started and not degraded
let degraded = false;
let capWarned = false;
let probeTimer: NodeJS.Timeout | null = null;

/** Everything watchable: the users tree plus every registered root (the
 *  exists probe happens at arm time — a missing dir is simply not armed). */
function targets(): Array<{ key: string; path: string }> {
  const t: Array<{ key: string; path: string }> = [];
  if (USER_FILES_DIR) t.push({ key: USERS_KEY, path: USER_FILES_DIR });
  for (const r of listRoots()) t.push({ key: r.key, path: r.path });
  return t;
}

/** One warning, then interval-only: close everything, stop probing, never
 *  re-arm. The fs-sync interval (and the agent/admin surfaces) keep working. */
function degrade(reason: unknown): void {
  if (degraded) return;
  degraded = true;
  active = false;
  console.warn(
    `[fs-watch] degrading to interval-only sync (recursive fs.watch unavailable or watcher failed): ${String(reason).slice(0, 200)}`,
  );
  for (const [, w] of watchers) {
    try {
      w.watcher.close();
    } catch {
      /* already dead */
    }
  }
  watchers.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

function schedule(key: string): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => fire(key), DEBOUNCE_MS);
  t.unref?.();
  pending.set(key, t);
}

/** Debounced trigger: the users pass for the users tree, a targeted
 *  syncMapping for every enabled mapping under the touched root. All sync
 *  code is synchronous, so fsSyncInFlight() is a belt-and-suspenders check —
 *  if a pass IS somehow running, re-debounce instead of overlapping it. */
function fire(key: string): void {
  pending.delete(key);
  if (fsSyncInFlight()) {
    schedule(key);
    return;
  }
  try {
    if (key === USERS_KEY) {
      syncUserFiles();
    } else {
      for (const m of db.listFsMappings()) {
        if (m.enabled && m.rootKey === key) syncMapping(m);
      }
    }
  } catch (e) {
    // syncMapping never throws; this guards syncUserFiles/listFsMappings so a
    // bad pass can't take the process (or the watcher) down with it.
    console.warn(`[fs-watch] triggered sync for '${key}' failed:`, e);
  }
}

function onEvent(key: string): void {
  lastEvent = { at: new Date().toISOString(), root: key };
  schedule(key);
}

/** Arm one recursive watcher. `syncOnArm` covers the late-mount case: files
 *  that landed before the watcher existed emit no events, so arming schedules
 *  one debounced pass (boot arming skips this — startFsSync just scanned). */
function arm(key: string, dir: string, syncOnArm: boolean): void {
  if (degraded || watchers.has(key)) return;
  if (!existsSync(dir)) return; // never watch a non-existent root
  if (watchers.size >= MAX_WATCHERS) {
    if (!capWarned) {
      capWarned = true;
      console.warn(`[fs-watch] watcher cap (${MAX_WATCHERS}) reached — '${key}' stays interval-only`);
    }
    return;
  }
  let w: FSWatcher;
  try {
    w = watch(dir, { recursive: true }, () => onEvent(key));
  } catch (e) {
    // The dir vanished between the exists probe and watch() — a mount race,
    // not a platform failure: the re-probe re-arms when it returns. Anything
    // else (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, EMFILE, ENOSPC) degrades.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    degrade(e);
    return;
  }
  // Runtime failures (EMFILE/ENOSPC under fd pressure) surface here — one
  // warning, interval-only, no crash loop and no per-event retry storm.
  w.on('error', (e) => degrade(e));
  watchers.set(key, { path: dir, watcher: w });
  if (syncOnArm) {
    lastEvent = { at: new Date().toISOString(), root: key };
    schedule(key);
  }
}

/** Re-probe tick: disarm watchers whose dir vanished, arm late mounts. */
function probe(): void {
  if (degraded) return;
  for (const [key, w] of watchers) {
    if (existsSync(w.path)) continue;
    try {
      w.watcher.close();
    } catch {
      /* already dead */
    }
    watchers.delete(key);
  }
  for (const t of targets()) {
    if (!watchers.has(t.key)) arm(t.key, t.path, true);
  }
}

const statusBlock = (): FsWatchStatusBlock => ({
  enabled: active,
  degraded,
  watchedRoots: [...watchers.entries()].map(([key, w]) => ({ key, path: w.path })),
  lastEvent,
});

/** Boot hook — call AFTER startFsSync() (the initial scan makes boot-time
 *  arming safe without a sync). Inert when killed, unconfigured, or degraded. */
export function startFsWatch(): void {
  registerFsWatchStatus(statusBlock);
  if (!ENABLED) return;
  if (!USER_FILES_DIR && listRoots().length === 0) return; // nothing to watch, ever
  active = true;
  for (const t of targets()) arm(t.key, t.path, false);
  if (degraded) return;
  if (REARM_S > 0) {
    probeTimer = setInterval(probe, REARM_S * 1000);
    probeTimer.unref?.(); // never keep the process alive just to probe
  }
}
