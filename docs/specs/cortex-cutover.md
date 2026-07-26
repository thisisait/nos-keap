# The cortex cutover (P-5)

Status: **implemented**, KEAP v1.29.0. Implements the C1 half of
`docs/specs/cortex-full-scope-decision.md` on the KEAP side, against the
`pazny.cortex` organ built by nOS P-4/P-4b.

## What changed

`POST /agent/v1/validate` and `GET /agent/v1/validate/opcodes` gained a second
possible answerer. One environment variable decides which:

| `CORTEX_BACKEND_URL` | backend | what runs |
| --- | --- | --- |
| unset / empty | `local` | `server/cortex-validate.ts` in this process — unchanged |
| set | `organ` | proxied to the nOS cortex daemon; the local typechecker never runs |

`GET /agent/v1/health` gained a `cortex` block naming the backend, and under
organ mode the organ's binding triple plus a drift verdict.

Required together: `CORTEX_TOKEN_RO`. The organ has its own token space; the
caller's KEAP bearer is authenticated by KEAP and then **not** forwarded,
because it means nothing on the other side. A deployment that sets the URL
without the token gets a 500 that names the missing variable, not the organ's
401 — the difference decides which host an operator goes to debug.

## Three decisions, and why

### 1. A switch, not a failover

There is deliberately no "organ unreachable ⇒ fall back to local". An
unreachable organ is a **502**.

The two backends answer with different `databaseId`s, and after C2 they will
answer over different trees. `ast.binding` exists precisely so a consumer can
tell those apart — Wing's dispatch rule is *"databaseId moved → REJECT, do not
revalidate"*. A silent fallback would hand out ASTs stamped by one language
while the operator believed the other was live, which is the identity-drift
failure the binding triple was built to make loud. The 502 is an outage that
says so.

### 2. The local implementation is NOT deleted

The nOS build sequence step 13 says *"delete KEAP's `server/cortex-*.ts`"*. That
ordering makes the cutover unrollable: once the code is gone, backing out means a
release, not a variable.

So the 4 211 lines stay for one release. `CORTEX_BACKEND_URL=` is a working
rollback that needs no rebuild. They go in the release after the organ has run
live — and that deletion is what closes the duplication, so it is owed, not
optional.

### 3. `ontology.version` still means the local store

Under organ mode `/agent/v1/health` keeps reporting **this** store's derived
hash in `ontology.version`. Repointing it at the organ would make one field
describe two different databases depending on a variable, while the four counts
beside it went on describing the local one.

The authoritative binding for a dispatched AST is `cortex.binding`. A consumer
that gates on it should read the organ directly — Wing already can, the daemon is
on `127.0.0.1:8098`, and going through KEAP to reach it adds a hop and a second
thing to be down.

## `cortex.ontologyDrift` — the port-drift detector

The organ is a **copy** of these modules over a **copy** of the tree. Its CI runs
its own vendored conformance fixtures, so it is self-consistent and by
construction cannot notice it has diverged from the KEAP tree it was cut from.
This field is the only place the two digests meet:

| value | meaning |
| --- | --- |
| `match` | both sides compose the same ontology — the port is current |
| `differs` | the vendored port and KEAP's tree have diverged |
| `null` | unknown: local mode, or the organ is unreachable |

`differs` has **two** legitimate meanings, which is why this is reported and
never enforced. Before C2 it means the port is stale and needs re-vendoring.
After C2 gives the organ its own corpus it is expected and harmless. KEAP cannot
tell which applies, and a gate that guessed would fire on the very migration it
is supposed to survive.

Measured at the time of writing: the drift between KEAP v1.27.0 (the vendor
point) and v1.28.0 is one comment block in `server/migrations.ts`. The risk is
not the current distance — it is that nothing else measures it at all.

## Operating it

```
# rollback — no rebuild, no deploy
unset CORTEX_BACKEND_URL

# is the cutover live, and is the port current?
curl -s localhost:8787/agent/v1/health | jq .data.cortex
```

`CORTEX_PROBE_CACHE_MS` (default 15 000) bounds how often KEAP's health probes
the organ. `/agent/v1/health` is unauthenticated, so without the cache an
external monitor's poll rate would set KEAP's request rate against the organ —
the cache is what stops an unauthenticated endpoint being a request amplifier. A
non-numeric or negative value falls back to the default rather than disabling it.

## What this does not do

- **Reasoning still runs against KEAP's corpus in local mode**, which is the
  deployed default until the organ is converged. Flipping the variable is the
  whole cutover; nothing else in KEAP changes behaviour.
- **`kg:` / `ent:` remain unresolvable** in both modes. They open only when the
  organ gains a caller identity (`cortex-full-scope-decision.md` §"the directive
  changes the answer"), and `ent:` additionally needs a writer for
  `object_type_definitions`.
- **The corpus does not move.** C2 — `knowledge_objects`, fs-sync, captures,
  embeddings, hybrid search — is untouched and still KEAP's.

## Coverage

- `server/cortex-backend.test.ts` — 18 cases over the switch, the transport, the
  probe cache and the drift verdict, with no database at all.
- `e2e/cortex-cutover.spec.ts` — 7 cases against the **built** `dist-server` in
  organ mode, driven by a stub organ that records what KEAP sent it. This is what
  proves the routes are wired to the switch; the unit suite would stay green if
  `registerAgentRoutes` never called it, which is exactly the mistake that ships
  a cutover doing nothing.
