/**
 * cortex-backend — WHERE reasoning is answered from (P-5, the cutover).
 *
 * KEAP's cortex modules (`server/cortex-*.ts`) were ported verbatim into the nOS
 * anatomy as `pazny.cortex`, a loopback host daemon owning its own libsql store
 * (`docs/specs/cortex-full-scope-decision.md`, C1). Two copies of one language
 * now exist. This module is the switch that decides which one answers, so the
 * cutover is a CONFIGURATION change and its rollback is unsetting one variable.
 *
 *   CORTEX_BACKEND_URL unset  ⇒ 'local'  — validate runs in this process
 *   CORTEX_BACKEND_URL set    ⇒ 'organ'  — validate is proxied to the daemon
 *
 * ── Why this is a switch and NOT a failover ─────────────────────────────────
 * There is deliberately no "organ unreachable ⇒ fall back to local". The two
 * backends answer with DIFFERENT `databaseId`s and, once the corpus migration
 * (C2) starts, a different tree — and `ast.binding` exists precisely so a
 * consumer can tell those apart. A silent fallback would hand Wing an AST
 * stamped by one language while the operator believes the other is live, which
 * is the identity-drift failure the binding triple was built to make loud. An
 * unreachable organ is therefore a 502: an outage that says so.
 *
 * The local implementation is NOT deleted at cutover (build sequence step 13
 * says delete; that ordering makes the switch unrollable). It stays for one
 * release so `CORTEX_BACKEND_URL=` is a working rollback, and goes in the
 * release after the organ has run live.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * The organ has its own token space (`CORTEX_TOKEN_RO`/`_RW`, provisioned by
 * `roles/pazny.cortex`). A caller's KEAP bearer is authenticated by KEAP's own
 * `agentAuth` and then NOT forwarded — it means nothing on the other side. KEAP
 * presents its own RO credential, because proxying validate is a read.
 */
import type { CortexValidateReport } from './cortex-validate';
import type { CortexOpcodeSpec } from './cortex-opcodes';

/** Transport budget for a proxied validate. Typechecking a 4096-char program is
 *  microseconds of work; anything near this bound is a sick daemon, and a
 *  caller waiting 30 s for a typecheck is worse off than one told to retry. */
const VALIDATE_TIMEOUT_MS = 5_000;
/** The health probe is on the liveness path — it must never be the reason
 *  /agent/v1/health is slow. */
const PROBE_TIMEOUT_MS = 2_000;
/** Probe cache TTL. /agent/v1/health is polled by dashboards; without this the
 *  poll rate of an external monitor would set the request rate against the
 *  organ — an unauthenticated endpoint that fans out to a backend is a request
 *  amplifier, and the cache is what stops it being one.
 *
 *  Overridable because the right value is a property of the DEPLOYMENT, not of
 *  this code: an operator watching a cutover wants health to reflect the organ
 *  within seconds, and one running a 10 s dashboard poll wants the opposite. A
 *  non-numeric or negative value falls back to the default rather than
 *  disabling the cache, because "misconfigured" must not resolve to
 *  "amplifier". */
const PROBE_CACHE_MS = (() => {
  const raw = Number.parseInt((process.env.CORTEX_PROBE_CACHE_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
})();

export type CortexBackendKind = 'local' | 'organ';

/** Thrown for every failure of the remote path. `status` is what the route
 *  should answer with — never the organ's own status verbatim, because a 401
 *  from the organ is KEAP's misconfiguration, not the caller's. */
export class CortexBackendError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'CortexBackendError';
    this.status = status;
  }
}

/** Read per call, not at module load: the routes are wired once at boot but the
 *  tests need to move the switch, and a module-load constant would force a
 *  module-registry reset per case (the trap server/relations.test.ts:13
 *  records). Trailing slashes are stripped so callers can set either form. */
export function cortexBackendUrl(): string | null {
  const raw = (process.env.CORTEX_BACKEND_URL ?? '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

export function cortexBackend(): CortexBackendKind {
  return cortexBackendUrl() ? 'organ' : 'local';
}

function organToken(): string | null {
  const raw = (process.env.CORTEX_TOKEN_RO ?? '').trim();
  return raw || null;
}

/**
 * One request to the organ, with the envelope unwrapped.
 *
 * The organ speaks KEAP's `{success, data}` / `{success, error}` envelope (it is
 * KEAP's own code). Everything that is not a 200 with `success: true` becomes a
 * `CortexBackendError` carrying the organ's own words, because an operator
 * debugging a cutover needs the far side's message, not a generic "upstream
 * error" that could mean any of six things.
 */
async function organFetch<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const base = cortexBackendUrl();
  if (!base) throw new CortexBackendError('cortex backend not configured', 500);

  const token = organToken();
  // Fail closed and SAY WHY. An unconfigured token would otherwise surface as
  // the organ's 401, which reads as "KEAP sent a bad token" when the truth is
  // "the deployment set CORTEX_BACKEND_URL without CORTEX_TOKEN_RO" — the exact
  // half-configured state a converge can produce.
  if (!token) {
    throw new CortexBackendError(
      'cortex backend configured (CORTEX_BACKEND_URL) but CORTEX_TOKEN_RO is not set',
      500,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        // Self-asserted on the far side and believed by nothing there (the
        // organ records it for a log line only). Sent so the organ's logs name
        // the proxy rather than 'unknown'.
        'x-keap-agent': 'keap-proxy',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : String(err);
    throw new CortexBackendError(`cortex backend unreachable at ${base}: ${reason}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CortexBackendError(`cortex backend returned a non-JSON ${res.status} from ${path}`);
  }

  const envelope = body as { success?: boolean; data?: T; error?: string };
  if (!res.ok || envelope.success !== true) {
    const detail = envelope.error ?? `HTTP ${res.status}`;
    throw new CortexBackendError(`cortex backend rejected ${path}: ${detail}`);
  }
  return envelope.data as T;
}

/** `POST /agent/v1/validate` on the organ. The report shape is the SAME type —
 *  the organ runs the same code — so nothing is re-parsed or re-validated here.
 *  Re-checking it would mean maintaining a second definition of the contract in
 *  the one place both sides are guaranteed to agree. */
export function remoteValidate(source: string, ttlSeconds: number): Promise<CortexValidateReport> {
  return organFetch<CortexValidateReport>(
    '/agent/v1/validate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, ttlSeconds }),
    },
    VALIDATE_TIMEOUT_MS,
  );
}

export interface CortexOpcodeListing {
  contract: number;
  registryHash: string;
  opcodes: readonly CortexOpcodeSpec[];
}

/** `GET /agent/v1/validate/opcodes` on the organ. Proxied rather than answered
 *  locally under organ mode on purpose: the registry a consumer gates against
 *  must be the registry that will typecheck its programs. Answering from the
 *  local registry while the organ does the validating is how a consumer comes to
 *  believe an opcode exists that the validator has never heard of. */
export function remoteOpcodes(): Promise<CortexOpcodeListing> {
  return organFetch<CortexOpcodeListing>('/agent/v1/validate/opcodes', { method: 'GET' }, VALIDATE_TIMEOUT_MS);
}

export interface OrganProbe {
  reachable: boolean;
  /** the organ's own binding triple, or null when unreachable */
  binding: { ontologyVersion: string; databaseId: string; opcodeRegistryHash: string } | null;
  /** why it is unreachable, for the health payload; null when reachable */
  error: string | null;
  /** epoch ms of the observation this reflects */
  observedAt: number;
}

let probeCache: OrganProbe | null = null;

/** Reset the memoised probe. Tests only — production has one process-lifetime
 *  cache on purpose. */
export function resetOrganProbeCache(): void {
  probeCache = null;
}

/**
 * The organ's `/health`, memoised, and NEVER throwing.
 *
 * This runs inside KEAP's own health handler. A reasoning backend that is down
 * is a fact KEAP's health should REPORT, not a reason KEAP's health should
 * fail — a monitor that cannot read the payload cannot read the field that says
 * what is wrong. Failures are cached alongside successes so a hard-down organ
 * costs one probe per TTL rather than one per poll.
 */
export async function probeOrgan(now: number = Date.now()): Promise<OrganProbe> {
  if (probeCache && now - probeCache.observedAt < PROBE_CACHE_MS) return probeCache;

  const base = cortexBackendUrl();
  if (!base) {
    probeCache = { reachable: false, binding: null, error: 'not configured', observedAt: now };
    return probeCache;
  }

  try {
    // Unauthenticated on the organ (liveness), so no token requirement here —
    // which is deliberate: the probe must still work, and still report the
    // binding, on a deployment whose token half is misconfigured.
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = (await res.json()) as {
      success?: boolean;
      data?: { binding?: OrganProbe['binding'] };
    };
    if (!res.ok || body.success !== true || !body.data?.binding) {
      throw new Error(`unexpected health payload (HTTP ${res.status})`);
    }
    probeCache = { reachable: true, binding: body.data.binding, error: null, observedAt: now };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : String(err);
    probeCache = { reachable: false, binding: null, error: reason, observedAt: now };
  }
  return probeCache;
}

export interface CortexBackendHealth {
  backend: CortexBackendKind;
  url: string | null;
  reachable: boolean | null;
  binding: OrganProbe['binding'];
  error: string | null;
  /**
   * The vendored-port drift detector.
   *
   * The organ is a COPY of these modules over a COPY of the tree. Its CI runs
   * its own vendored conformance fixtures, so it is self-consistent and by
   * construction cannot notice that it has diverged from the KEAP tree it was
   * cut from. This field is the only place the two digests meet:
   *
   *   'match'    both sides compose the same ontology — the port is current
   *   'differs'  the vendored port and KEAP's tree have diverged. Expected and
   *              HARMLESS once C2 gives the organ its own corpus; before that it
   *              means the port is stale and needs re-vendoring.
   *   null       unknown (local mode, or the organ is unreachable)
   *
   * Reported, never enforced: KEAP cannot know which of the two intended
   * meanings applies, and a gate that guesses would fire on the migration it is
   * supposed to survive.
   */
  ontologyDrift: 'match' | 'differs' | null;
}

/** The `cortex` block of `GET /agent/v1/health`. `localOntologyVersion` is
 *  passed in rather than imported so this module stays free of the DB —
 *  it is the only cortex module a unit test can exercise without a store. */
export async function cortexBackendHealth(localOntologyVersion: string): Promise<CortexBackendHealth> {
  const backend = cortexBackend();
  if (backend === 'local') {
    return { backend, url: null, reachable: null, binding: null, error: null, ontologyDrift: null };
  }
  const probe = await probeOrgan();
  return {
    backend,
    url: cortexBackendUrl(),
    reachable: probe.reachable,
    binding: probe.binding,
    error: probe.error,
    ontologyDrift: probe.binding
      ? probe.binding.ontologyVersion === localOntologyVersion
        ? 'match'
        : 'differs'
      : null,
  };
}
