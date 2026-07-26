import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CortexBackendError,
  cortexBackend,
  cortexBackendHealth,
  cortexBackendUrl,
  probeOrgan,
  remoteOpcodes,
  remoteValidate,
  resetOrganProbeCache,
} from './cortex-backend';

/**
 * The P-5 switch. No database and no store: this module is deliberately the one
 * cortex file that touches neither, so the cutover's failure modes can be tested
 * as pure transport behaviour.
 *
 * The load-bearing assertion in here is `does not fall back to local` — every
 * other test describes a shape, that one describes the decision the module
 * exists to make.
 */
const ORGAN = 'http://127.0.0.1:8098';

function envelope(data: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetOrganProbeCache();
  delete process.env.CORTEX_BACKEND_URL;
  delete process.env.CORTEX_TOKEN_RO;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CORTEX_BACKEND_URL;
  delete process.env.CORTEX_TOKEN_RO;
});

describe('the switch', () => {
  it('is local when CORTEX_BACKEND_URL is unset', () => {
    expect(cortexBackend()).toBe('local');
    expect(cortexBackendUrl()).toBeNull();
  });

  it('treats an empty or whitespace value as unset', () => {
    // A converge that renders the variable with no value must not half-flip the
    // cutover: `CORTEX_BACKEND_URL=""` is an absent backend, not a broken one.
    process.env.CORTEX_BACKEND_URL = '   ';
    expect(cortexBackend()).toBe('local');
  });

  it('is organ when a URL is set, and normalises trailing slashes', () => {
    process.env.CORTEX_BACKEND_URL = `${ORGAN}//`;
    expect(cortexBackend()).toBe('organ');
    expect(cortexBackendUrl()).toBe(ORGAN);
  });
});

describe('remoteValidate', () => {
  beforeEach(() => {
    process.env.CORTEX_BACKEND_URL = ORGAN;
    process.env.CORTEX_TOKEN_RO = 'ro-secret';
  });

  it('posts the program and unwraps the organ envelope', async () => {
    const report = { valid: true, phase: 1, complete: true, ast: { binding: { databaseId: 'organ-db' } } };
    const fetchMock = vi.fn().mockResolvedValue(envelope(report));
    vi.stubGlobal('fetch', fetchMock);

    await expect(remoteValidate('get(tax:nos)', 900)).resolves.toMatchObject({ valid: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORGAN}/agent/v1/validate`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ source: 'get(tax:nos)', ttlSeconds: 900 });
  });

  it('presents KEAP’s own organ credential, not the caller’s bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ valid: true }));
    vi.stubGlobal('fetch', fetchMock);

    await remoteValidate('get(tax:nos)', 900);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.authorization).toBe('Bearer ro-secret');
    expect(headers['x-keap-agent']).toBe('keap-proxy');
  });

  it('refuses a half-configured deployment by naming the missing half', async () => {
    // URL set, token not: exactly what a converge produces if one variable is
    // plumbed and the other is not. The organ would answer 401, which reads as
    // "KEAP sent a bad token" — the wrong host to go debug.
    delete process.env.CORTEX_TOKEN_RO;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(remoteValidate('get(tax:nos)', 900)).rejects.toThrow(/CORTEX_TOKEN_RO is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT fall back to the local typechecker when the organ is unreachable', async () => {
    // The whole point of the cutover. A fallback would answer with a report
    // stamped by a DIFFERENT databaseId while the operator believes the organ is
    // live — the identity drift `ast.binding` exists to make loud.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const err = await remoteValidate('get(tax:nos)', 900).catch((e) => e);
    expect(err).toBeInstanceOf(CortexBackendError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unreachable/);
  });

  it('surfaces the organ’s own words when it rejects the call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'invalid token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const err = await remoteValidate('get(tax:nos)', 900).catch((e) => e);
    // 502, not 401: the organ rejecting KEAP is KEAP's misconfiguration. Passing
    // 401 through would tell the caller to fix a token it does not hold.
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/invalid token/);
  });

  it('treats a non-JSON reply as a backend failure, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );

    const err = await remoteValidate('get(tax:nos)', 900).catch((e) => e);
    expect(err).toBeInstanceOf(CortexBackendError);
    expect(err.message).toMatch(/non-JSON/);
  });
});

describe('remoteOpcodes', () => {
  it('proxies the registry rather than answering from the local copy', async () => {
    process.env.CORTEX_BACKEND_URL = ORGAN;
    process.env.CORTEX_TOKEN_RO = 'ro-secret';
    const listing = { contract: 1, registryHash: 'cx1:organ', opcodes: [] };
    const fetchMock = vi.fn().mockResolvedValue(envelope(listing));
    vi.stubGlobal('fetch', fetchMock);

    await expect(remoteOpcodes()).resolves.toEqual(listing);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORGAN}/agent/v1/validate/opcodes`);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});

describe('probeOrgan', () => {
  const BINDING = {
    ontologyVersion: 'onto1:aaaa',
    databaseId: 'organ-db',
    opcodeRegistryHash: 'cx1:bbbb',
  };

  beforeEach(() => {
    process.env.CORTEX_BACKEND_URL = ORGAN;
  });

  it('reads the binding triple off the organ health payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ binding: BINDING })));
    await expect(probeOrgan(1_000)).resolves.toMatchObject({ reachable: true, binding: BINDING });
  });

  it('memoises within the TTL so an external monitor cannot set the probe rate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ binding: BINDING }));
    vi.stubGlobal('fetch', fetchMock);

    await probeOrgan(1_000);
    await probeOrgan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await probeOrgan(1_000 + 15_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the FAILURE too, and never throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    // A hard-down organ must cost one probe per TTL, not one per health poll.
    await expect(probeOrgan(1_000)).resolves.toMatchObject({ reachable: false, binding: null });
    await expect(probeOrgan(2_000)).resolves.toMatchObject({ reachable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 that is not the health payload it expects', async () => {
    // A reverse proxy answering 200 with its own body is reachable and useless;
    // reporting it as reachable would put a live-looking organ in the payload.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ status: 'OK' })));
    await expect(probeOrgan(1_000)).resolves.toMatchObject({ reachable: false });
  });
});

describe('cortexBackendHealth', () => {
  it('reports nothing to compare in local mode', async () => {
    await expect(cortexBackendHealth('onto1:local')).resolves.toEqual({
      backend: 'local',
      url: null,
      reachable: null,
      binding: null,
      error: null,
      ontologyDrift: null,
    });
  });

  it('reports match when the vendored port composes the same ontology', async () => {
    process.env.CORTEX_BACKEND_URL = ORGAN;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelope({ binding: { ontologyVersion: 'onto1:same', databaseId: 'o', opcodeRegistryHash: 'c' } }),
      ),
    );
    await expect(cortexBackendHealth('onto1:same')).resolves.toMatchObject({
      backend: 'organ',
      reachable: true,
      ontologyDrift: 'match',
    });
  });

  it('reports differs when the two trees have diverged', async () => {
    // The only place the vendored port and KEAP's tree meet. The organ's own CI
    // runs its own vendored fixtures and is therefore structurally blind to this.
    process.env.CORTEX_BACKEND_URL = ORGAN;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        envelope({ binding: { ontologyVersion: 'onto1:organ', databaseId: 'o', opcodeRegistryHash: 'c' } }),
      ),
    );
    await expect(cortexBackendHealth('onto1:keap')).resolves.toMatchObject({ ontologyDrift: 'differs' });
  });

  it('reports drift as unknown rather than guessing when the organ is down', async () => {
    process.env.CORTEX_BACKEND_URL = ORGAN;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(cortexBackendHealth('onto1:keap')).resolves.toMatchObject({
      backend: 'organ',
      reachable: false,
      ontologyDrift: null,
    });
  });
});
