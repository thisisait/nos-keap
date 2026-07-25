# The knowledge/ mount split — one SoT, two sampling times

Status: **open hazard, documented not fixed.** Written against KEAP v1.27.0 and
the `pazny.keap` role as it stood on 2026-07-25. Every claim below is cited to a
file and line so the nOS side can act on a written statement instead of the
memory of a conversation.

**KEAP cannot fix this.** The wiring lives entirely in the nOS repo
(`roles/pazny.keap/`), which this repo must treat as read-only. What follows is
the precise statement of what is wired, which invariant is unenforced, how it
fails, and what a converge would have to do differently. §6 is the actionable
part.

---

## 1. What is actually wired today

Two halves of the same checkout reach the container by two different mechanisms:

| Half | Mechanism | Sampled at | Evidence |
|---|---|---|---|
| Application code (`dist/`, `dist-server/`, `node_modules/`) | baked into image `nos/keap:{{ keap_version }}` | **image build time** | `compose.yml.j2:27-30`, `Dockerfile:46-51` |
| `knowledge/` (canonical, ontology, spine, `*.mjs`) | read-only bind mount over `/app/knowledge` | **every file access, live** | `compose.yml.j2:48` |

Both originate from the *same directory* — `keap_src_dir`
(`~/keap/src`, `roles/pazny.keap/defaults/main.yml:17`), which is the build
context on line 28 and the mount source on line 48.

That is the whole point of the hazard: **same directory, two sampling times, and
nothing asserts the two samples are the same commit.**

### 1.1 The mount shadows the image completely

The Dockerfile bakes exactly three files into `/app/knowledge/`:

```
COPY --from=build /app/knowledge/ingest.mjs ./knowledge/ingest.mjs   # Dockerfile:71
COPY --from=build /app/knowledge/dump.mjs   ./knowledge/dump.mjs     # Dockerfile:72
COPY --from=build /app/knowledge/lint.mjs   ./knowledge/lint.mjs     # Dockerfile:73
```

The compose mount then covers the entire `/app/knowledge` directory
(`compose.yml.j2:48`), so **all three baked files are permanently invisible.**
The `ingest.mjs` that `post.yml:71` executes
(`docker exec iiab-keap-1 node knowledge/ingest.mjs`) is always the host
checkout's copy, never the image's. The baked copies have never run in this
configuration and cannot.

This is not a criticism of the mount — it is load-bearing, see §3 — but the
Dockerfile's own comment (`Dockerfile:52-70`, now corrected) described the superseded
design ("the canonical data is NOT baked… a data change needs no image
rebuild"). That comment is corrected in the same commit as this document; the
`COPY` lines are deliberately left in place, because removing them would make
the image unrunnable *without* the mount, and that is a decision for whoever
owns §6, not for a docs pass.

### 1.2 The mount is unconditional

Line 48 sits **above** the `{% if keap_fs_sync %}` guard on line 49. There is no
flag that turns the knowledge mount off. Good — because it must never be off
(§3).

### 1.3 Nothing in the running server reads `knowledge/`

Verified: no non-test file under `server/` imports from `../knowledge/`.
`dist-server/index.js` does not load it. `/app/knowledge` is used **only** by
`docker exec` invocations — the `post.yml:71` ingest, and any manual
`dump.mjs`/`lint.mjs` run.

The blast radius is therefore not "the server serves stale data". It is
narrower and nastier: **the ingest step — the thing that writes the SoT into the
live DB — runs code that the image was never built with or tested against.**

---

## 2. The invariant nobody enforces

> The `knowledge/` tree visible at `/app/knowledge` MUST be from the same commit
> as the `dist-server/` and `node_modules/` baked into the running image.

Nothing checks this. Specifically:

- **No version handshake.** `ingest.mjs` does not assert anything about the
  image it is running inside; the server does not assert anything about the
  mount. There is no shared fingerprint, no `KEAP_VERSION` compared against a
  `knowledge/manifest`.
- **No restart or rebuild is required for the mount to change.** Editing,
  `git checkout`-ing, or `git pull`-ing the host directory changes what the
  *already-running* container sees, instantly, with no signal.
- **The two pins are separate variables.** `keap_version: "1.27.0"`
  (`default.config.yml:2145`, the image tag) and `keap_repo_ref: "v1.27.0"`
  (`roles/pazny.keap/defaults/main.yml:45`, the git ref) are independent
  strings. The convention that they move together is a convention, not a check.

### 2.1 The dependency coupling that makes it bite

`knowledge/ingest.mjs` is **not** dependency-free. Line 30:

```js
import Database from 'libsql';
```

Node resolves that to `/app/node_modules/libsql` — which is **baked into the
image** (`Dockerfile:46`, `npm ci --omit=dev --ignore-scripts`). So a
host-supplied script executes against image-supplied native dependencies.

Any commit that changes `ingest.mjs`'s imports, or bumps `libsql`, splits the
two halves in a way that surfaces as a module-resolution or ABI error at
*ingest* time — i.e. during a converge, mid-write, against the live DB.

This has already happened once. `compose.yml.j2:41-47` records it: the v1.26.0
image shipped `ingest.mjs` without `_ontology.mjs`, producing
`ERR_MODULE_NOT_FOUND` on a blank all-on install (2026-07-24). Mounting all of
`knowledge/` was the fix. It fixed the *file-completeness* half of the problem
and left the *version-agreement* half untouched.

---

## 3. The mount is load-bearing, and its removal is now fatal

v1.27.0's `knowledge/` contains far more than the three baked files:

```
_provenance/  _schema/  canonical/  fixtures/  ontology/  spine/
_ontology.mjs  dump.mjs  ingest.mjs  lift-xrefs.mjs  lint.mjs
onto1-compose.mjs  onto1-conformance.mjs  ontology-sot.test.mjs
README.md  roundtrip-setup.mjs  roundtrip.mjs  spine-render.mjs
```

`ingest.mjs` imports `./_ontology.mjs`, which is **not** baked. So:

- **With the mount:** everything present, from the host commit.
- **Without the mount:** `ERR_MODULE_NOT_FOUND` on the first ingest — the exact
  2026-07-24 failure.

The handoff phrased the rule as *"mount all of knowledge/ or none"*
(`compose.yml.j2:46-47`). As of v1.27.0 the "or none" branch no longer exists:
the image cannot self-serve an ingest. Anyone reasoning about this template
should know that removing line 48 is not a fallback — it is an outage.

---

## 4. Concrete failure modes

**F1 — Code/data skew on a partial bump (most likely).**
`keap_repo_ref` advances but `keap_version` does not, or vice versa. Because
`stack-up.yml:195,267` runs `up -d --build`, the image is rebuilt and *retagged*
from the current checkout, so in the common path the halves re-converge by
accident. But `--build` also means **an unchanged `keap_version` silently ships
different code** — the tag `nos/keap:1.27.0` is mutable and now means whatever
the checkout was at the last converge. The image tag is not a version; it is a
label on the most recent build. Any rollback that pins `keap_version` alone will
not roll code back.

**F2 — Live drift between converges (silent).**
The mount has no snapshot semantics. Anything that touches `~/keap/src/knowledge`
between converges — a manual `git checkout` to inspect an older tag, an
interrupted converge, an editor, a stray `git pull` — changes what the running
container ingests on its *next* `docker exec`, with no restart, no log line, and
no gate. The running server keeps serving the old code.

**F3 — Dependency skew at ingest time (loudest, worst-timed).**
Per §2.1: host `ingest.mjs` + image `node_modules`. Fails during a converge,
while writing the live DB.

**F4 — Checkout stuck behind the pin (currently true).**
`roles/pazny.keap/tasks/main.yml:63-67` uses `ansible.builtin.git` with
`force: false`. A dirty checkout makes it refuse rather than reset. **Observed
2026-07-25:** `~/keap/src` is clean but sits at `v1.26.0`
(`git describe` → `v1.26.0`, `package.json` → `1.26.0`, no cortex code, no
`knowledge/spine/`, no `onto1-*.mjs`) while `keap_repo_ref` is `v1.27.0`. The
deployed instance is therefore a *consistent* v1.26.0, one minor version behind
its own pin — not split, but not what the pin claims either. A converge has not
run since the bump. This is the benign case; F1–F3 are what happens when it
half-runs.

---

## 5. What is NOT the problem

Worth stating, because the original framing ("compose bind-mounts
`knowledge/canonical` while the rest comes from the image") describes a wiring
that no longer exists:

- The template **already** mounts all of `knowledge/`, not just `canonical/`
  (`compose.yml.j2:48`). The canonical-vs-ontology split *within* the mount was
  fixed on 2026-07-24.
- Both halves come from the **same directory**, so they are not two independent
  checkouts that can diverge arbitrarily.

The residual hazard is strictly **temporal**: one directory, sampled at image
build time and again at every file access, with no assertion that the samples
agree.

---

## 6. What a converge would have to do differently

For the nOS side. Ordered cheapest-first; the first two remove most of the risk.

1. **Assert the checkout is at the pin, before building.**
   After the `git` task (`roles/pazny.keap/tasks/main.yml:63`), fail loudly if
   `git -C {{ keap_src_dir }} describe --tags` does not equal `keap_repo_ref`.
   This alone converts F4 from silent to obvious, and would have surfaced the
   v1.26.0/v1.27.0 gap above.

2. **Assert the two pins agree.**
   `keap_version` and `keap_repo_ref` encode the same release
   (`v{{ keap_version }} == keap_repo_ref`). Make that a pre-flight assertion
   rather than a convention. Kills F1's rollback trap.

3. **Make the image tag immutable per build.**
   `nos/keap:1.27.0` currently means "whatever the last `--build` produced".
   Either tag with the resolved commit SHA
   (`nos/keap:1.27.0-{{ keap_src_sha[:8] }}`), or stop rebuilding an
   already-present tag. Until then, `keap_version` cannot be used to roll back.

4. **Give the ingest a version handshake.**
   The durable fix for F3. Have the converge compare the mounted tree's version
   against the image's before running `ingest.mjs` — e.g. `docker exec` a check
   that `/app/package.json`'s version matches the checkout's, and refuse the
   ingest on mismatch. Refusing to ingest is always cheaper than a half-applied
   ontology. **KEAP can help here**: if the nOS side wants it, this repo can ship
   a `knowledge/version-check.mjs` that exits non-zero on skew — say the word and
   it lands in the next release, since it must be baked *and* mounted to work.

5. **Snapshot the mount instead of live-binding it** (optional, larger).
   Copy `knowledge/` into a per-release directory at converge time and mount
   *that*, so the running container's view cannot change under it between
   converges. Removes F2 entirely. Costs a copy per converge and a cleanup rule.

6. **Correct the stale comments.** Two of them, both describing the pre-2026-07-24
   wiring:
   - `compose.yml.j2:36-39` still says the mount exists so "data changes ride the
     git ref, never an image rebuild". With `up -d --build` on every converge
     that is no longer why it exists — it exists because the image cannot
     self-serve an ingest (§3). The comment invites exactly the wrong
     conclusion: that skipping a rebuild is safe.
   - `roles/pazny.keap/tasks/post.yml:63` still says "knowledge/canonical is
     bind-mounted RO from the clone". It is the whole of `knowledge/`, and the
     distinction is the entire subject of this document.

   (The KEAP-side equivalent, `Dockerfile:52-70`, is corrected in the same commit
   as this file — see §7.)

---

## 7. What KEAP will do on its side

- **Not** change `Dockerfile`'s `COPY` lines. Baking the whole of `knowledge/`
  would make the image self-sufficient and end the split — but it would also
  make every canonical edit an image rebuild, which is a deployment-shape
  decision belonging to the nOS side. Named here as the obvious alternative to
  §6.5, not taken unilaterally.
- Corrected the stale `Dockerfile` comment describing a `canonical`-only mount
  (same commit as this document).
- Standing offer: `knowledge/version-check.mjs` per §6.4, on request.
