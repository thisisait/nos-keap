# The recall gate — what it measures, what it cannot, and how to read it

Status: **shipped.** `scripts/recall-gate.mjs`, written against v1.27.0.
Measured numbers in §6 are from a real run on 2026-07-25.

Every other check in the chain gates **form**: charsets, anchor integrity, id
stability, description length. The failure that started this track — nine
`_stack.md` cards outranking real content for *Nuclear Engineering* — passed all
of them. Sixty templated node descriptions would pass lint (`en ≥ 20 chars`) and
wreck recall identically. We measure length because it is easy; what fails is
meaning.

This gate measures meaning, and it is built so that it cannot flatter itself.

---

## 1. What it measures

A query set of `{q, expect[], forbid[]}` cases is run through the **real** hybrid
search (RRF over lexical + vector + graph legs), against a **real** embedded
corpus, and each case asserts two things:

- **presence** — at least one `expect` ref is in the top *k* (default 5), and
- **relative order** — no `forbid` ref outranks it.

`forbid` is the point. The `_stack.md` failure was *relative*: generic
self-model items capturing queries that specific ones should own. A gate that
only asked "is the right thing somewhere in the top 5" would have shipped it.

Two modes, same semantics and same exit codes:

| mode | corpus | what it proves |
| --- | --- | --- |
| **fixture** (default) | throwaway KEAP booted from `--fixture DIR`, cards from `--skills DIR`, embedded through the real pending → Ollama → POST loop | a tree is good **before** it ships |
| **live** (`--base URL`) | an already-running KEAP, read-only through `/agent/v1` with `KEAP_AGENT_TOKEN_RO` | the corpus that **actually** shipped, embedded by the live pulse job |

Ranking happens **within scope** (`spec.scope`, default `nos`). Absolute
corpus-wide rank against the 790-node seed spine is a stricter, different
property: it is printed as diagnostics and never gated, because otherwise every
generic phrasing would fail against the spine and the gate would be ignored.

Two exemptions are applied and both are **reported, never silent**:

- **graph-only hits are not relevance.** A hit whose only leg is `graph` was
  surfaced by topology — the graph leg hops one step out from the real hits, so
  a stack is every system's neighbour no matter what its text says. The router
  routes on meaning; the gate ranks only hits that earned a lexical or vector leg.
- **proper ancestors of the target are navigation, not competition.** A parent
  stack ranking beside its own child is the search working as designed. A
  *sibling* above the target is the `_stack.md` class and is never exempt.

## 2. What it cannot measure — and says so

**A case whose expectations name nothing in the corpus under test is not a
failure. It is not a pass either. It is a case that never ran.** Conflating the
two turns a coverage gap into a wall of false reds that buries the real signal;
hiding it turns a 5% sample into a green light. So the gate reports it as its
own quantity, broken down by cause:

| cause | meaning | whose problem |
| --- | --- | --- |
| `gap:both-absent` | neither the expected node nor the expected card exists here | corpus owner |
| `gap:node-absent` | the only expectation was a node id, absent here | corpus owner |
| `gap:card-absent` | the only expectation was a card title, absent here | corpus owner |
| `ambiguous-title` | the title exists on several cards and nothing scopes it | query set / KEAP |

And a case can be measured on **less** than it named. If a case says
`[node:nos.iiab.nextcloud, title:get-user-info]` and the card is missing, the
node still resolves and the case is graded — on the *system*, not on the *skill*
it is actually about. That is real coverage of a smaller claim, so it is counted
as `DEGRADED` rather than left to pass silently.

Three more things the gate deliberately does **not** claim:

- **`expect` is a UNION.** A pass means the node **or** the card made top-*k*.
  The summary prints `PASS SHAPE — node+card / card only / SYSTEM NODE ONLY`;
  the last bucket is a pass where the named skill never appeared.
- **rank *k* is one slot from a miss.** The rank histogram is printed, and cases
  sitting at exactly *k* are called out.
- **it is not a benchmark.** These are curated query→winner pairs, not a
  sampled distribution of real traffic. It catches regressions; it does not
  estimate recall in the wild.

## 3. `title:` is not a unique handle (a defect this gate shipped with)

Card ids are content-addressed (`fs:nos-docs:ca724ab6…`), so query sets name
cards by title. Titles are **not unique across an estate**: the live corpus has
six duplicated skill names (`create-document`, `list-users`, `list-dashboards`,
`create-post`, `list-databases`, `list-libraries`). The gate used to resolve them
through a last-write-wins map, and the consequences were measured, not theorised:
30 cases named a duplicated title, **13 resolved to a card owned by a different
system than the case meant**, producing 3 false reds (ERPNext's
`create-document` ranked #1 while the gate graded Outline's) and 2 false greens.

Fix, KEAP-side: a `title:` ref resolves **within the subtree of the node the same
case names**. Preference order is (a) a card anchored at or under the expected
node, (b) a card anchored at an ancestor of it, (c) unresolved. An unscopeable
duplicate is `ambiguous-title` — unmeasurable, never guessed, because guessing
is how the false reds happened.

nOS's generator is not at fault here: it is reasonable to assume skill names are
unique *per system*. They are not unique *per estate*.

## 4. The baseline — regression and corpus gap are different problems

`--update-baseline` records the current passing set to
`e2e/baselines/<slugified-query-path>.<mode>.json`. A later run then reports:

| line | meaning |
| --- | --- |
| `REGRESSIONS` | passed then, **fails now** — KEAP's ranking moved. Ours to fix. |
| `NEW & FAILING` | the case is not in the baseline at all — a new expectation, not a regression |
| `COVERAGE LOST` | was measurable, **is not now** — the corpus shrank or drifted. Not a recall failure. |
| `NEW COVERAGE` | was unmeasurable, is measured now |
| `FIXED` | failed then, passes now |

Baselines are keyed by **query set × mode** and the file records both. A baseline
recorded for a different set or a different mode is *refused*, not silently
compared — fixture mode and live mode measure different corpora, and comparing
across them would manufacture exactly the coverage lie this gate exists to
prevent. (The two self-model sets even share a basename, so the whole path is
slugified into the filename.)

## 5. How to read the output

```
── RECALL GATE — ../nOS/tests/fixtures/selfmodel-recall.json (live mode, k=5, scope=nos) ──
   cases in set   261
   MEASURED       100.0% (261/261) of the set
   PASSING        100.0% (261/261) of MEASURED  ← never of 261
   FAILING        0/261 measured
   UNMEASURABLE   0/261 — not failures, and not passes either
   PASS SHAPE     node+card 112 · card only 149 · SYSTEM NODE ONLY 0
   RANKS          rank1 235 · rank2 23 · rank3 2 · rank4 1
```

**Rule of this gate: no percentage is ever printed without the fraction that
produced it.** `PASSING` is always *of MEASURED*, and `MEASURED` is always
*of the set*, on the line above it. If you ever see a bare percentage from this
script, that is a bug — the repo shipped "corpus exhausted" once and the whole
point of this format is that reading it honestly is the path of least resistance.

The machine-readable line is `RECALL_RESULT {…}` on **stdout** (everything else
is stderr): `{queries, mode, cases, measured, passing, failed[], unmeasurable,
unmeasurableByCause{}, degradedByCause{}, passShape{}, ranks{}, baseline{…},
embedded, report[]}`.

### Exit codes — four states, deliberately distinct

| code | meaning |
| --- | --- |
| `0` | every measured case passed **and** coverage did not shrink |
| `1` | at least one measured case failed (flagged NEW/regression/known against the baseline) |
| `4` | **loud skip, never a pass**: no embedder, query set missing, zero measurable cases, coverage below `--min-measured`, or coverage lost against the baseline |

`--min-measured` **defaults to 50%** rather than to nothing. The failure being
fixed here is precisely a green exit over a 5% sample; a gate must refuse to call
itself passing when most of its set never ran, whether or not CI remembered to
ask. Pass `--min-measured 100%` when the corpus is supposed to cover everything,
or `--min-measured 0` to opt out deliberately.

## 6. Running it

```bash
npm run gate:recall                 # in-repo 4-case set against the in-repo fixture
npm run gate:recall:nos             # the 261-case nOS set against the in-repo fixture
KEAP_AGENT_TOKEN_RO=$(docker exec iiab-keap-1 printenv KEAP_AGENT_TOKEN_RO) \
  npm run gate:recall:nos:live      # the 261-case nOS set against the live estate
```

The nOS set is **read where nOS keeps it** (`../nOS/tests/fixtures/selfmodel-recall.json`,
override with `KEAP_NOS_QUERIES`). It is never copied into this repo: a fork
would silently diverge from the contract it is supposed to check.

Real results, 2026-07-25, v1.27.0:

| run | measured | passing | exit |
| --- | --- | --- | --- |
| `gate:recall` (in-repo set, in-repo fixture) | 4/4 | 4/4 | 0 |
| `gate:recall:nos:live` (nOS set, live estate) | **261/261** | **261/261** — rank1 235, rank2 23, rank3 2, rank4 1 | 0 |
| `gate:recall:nos` (nOS set, in-repo fixture) | **14/261** | 14/14 | **4** |

That last row is the one that matters. Before this work it exited **0**: the
shipped default measured 5.4% of the set — all 14 measurable cases belonging to a
single system — and reported a pass. It now exits 4 and prints the 247-case gap
with the systems it is made of (`grafana×25, gitea×18, n8n×16, authentik×16,
homeassistant×15, …`, 22 systems in the set vs 3 in the fixture).

**That gap is not KEAP's to paper over.** Against the live corpus the same 261
cases are 100% measurable — every expected node id and every expected card title
exists there. The gap is a property of the in-repo fixture, which was built to
prove one stack-pair and is being asked a question about an estate. Closing it
means shipping a larger canonical fixture (nOS's tree, nOS's cards) — a corpus
decision, made by the corpus owner, not a resolution rule bent until the number
looks better.
