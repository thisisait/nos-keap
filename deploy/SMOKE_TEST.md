# KEAP smoke test — after `nOS playbook` run

Step-by-step verification of the full suite on a live nOS deploy. Written for the
2026-07-11 state of the branch (S1 objects + U1 baked layout + 3D-only explorer).
Replace `8091` with your `keap_port` and `pazny.lab` with your `tenant_domain`.

> **⚠️ Before the playbook — force an image rebuild.** The role clones this repo at
> `keap_repo_ref` (a branch), so tonight's clone WILL have the newest commits — but
> `docker compose up` will NOT rebuild if the image tag (`nos/keap:<keap_version>`)
> already exists from a previous run. Either bump `keap_version` in
> `default.config.yml` (e.g. `0.3.0` — S1+U1 deserve it) or remove the stale image
> first: `docker rmi nos/keap:0.2.1`.

## 1. Container & health

```bash
docker ps --filter name=keap                       # Up (healthy) after ~20 s
curl -s http://127.0.0.1:8091/api/health           # {"success":true,...}
```

## 2. Identity boundary (trusted proxy)

```bash
# Headerless loopback request MUST be rejected — never a fallback identity:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8091/api/me   # 401
```

In the browser: `https://keap.pazny.lab` → Authentik login → app loads.
Admin tabs appear only when your account is in the **`nos-admins`** group
(the header check is exact — "authentik Admins" does NOT count).

## 3. Agent surface (bearer tokens from the role / default.credentials.yml)

```bash
RO=<keap ro token>; RW=<keap rw token>; B=http://127.0.0.1:8091

curl -s $B/agent/v1/health | python3 -m json.tool         # surface: enabled, corpus counts
curl -s -H "Authorization: Bearer $RO" "$B/agent/v1/taxonomy/search?q=quantum"

# Hybrid RRF search (S4) — one typed ranked list over the whole corpus.
# legs.lexical is always true; legs.vector flips true once KEAP_OLLAMA_URL
# is wired; legs.graph true when one-hop expansion contributed:
curl -s -H "Authorization: Bearer $RO" "$B/agent/v1/search/semantic?q=quantum&limit=5" \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; \
      print(d['legs']); [print(r['kind'], r.get('name') or r.get('title')) for r in d['results']]"
# expected: {'lexical': True, ...} + Quantum Foundations/Computing/Optics
# nodes and 'Physics' arriving via the graph leg
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST -H "Authorization: Bearer $RO" $B/agent/v1/objects \
  -H 'content-type: application/json' -d '{"type":"note","title":"x"}'   # 403 (ro can't write)
curl -s -X POST -H "Authorization: Bearer $RW" -H 'X-KEAP-Agent: smoketest' \
  -H 'content-type: application/json' $B/agent/v1/objects \
  -d '{"type":"note","title":"smoke object","body":"anchored to [[01.01]]"}'
  # → {"success":true,...,"submittedBy":"agent:smoketest"}
```

## 4. Deterministic layout (U1 — the spatial-memory contract)

```bash
curl -s -H 'x-authentik-uid: t' -H 'x-authentik-username: t' $B/api/graph \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; \
      print(d['meta']['layoutVersion'], d['nodes'][0]['x'], d['nodes'][0]['y'])"
# expected with the current 790-node tree:  v1:f99c46a4f3fbc805  1400  0
```

Restart the container (`docker restart <keap>`) and run it again — **identical
output**. The log must NOT print `[layout] baked …` on the restart.

## 5. Embeddings (host Pulse job)

```bash
# Trigger keap-embed-sync manually (or wait for the 04:45 UTC run), then:
curl -s $B/agent/v1/health | python3 -c "import json,sys; \
  print(json.load(sys.stdin)['data']['embeddings'])"
# expected: total ≥ 791 (790 taxonomy + the smoke object), model nomic-embed-text
```

## 6. Explorer (browser, the fun part)

1. `https://keap.pazny.lab/explore` — 3D universe: 12 labelled galaxies on a ring,
   constellation shells around each, faint starfield backdrop, glow (bloom).
   **No 2D toggle** (retired).
2. The smoke object from step 3 appears as a small teal dust dot near node `01.01`.
3. Click any node → side panel shows the semantic neighbourhood (needs step 5;
   until then the tree + panel work, `semantic: false`).
4. Reload the page — every star is exactly where it was. That's M2.
5. **Hyperspace jump** (header search): type `quantum`, Enter → the camera warps
   to the best hit's star. A miss turns the input red.
6. **Ship mode** (Loď button): crosshair HUD appears; drag to look, WASD to fly,
   R/F for up/down. Toggle back to Pozorovatel for orbit. Reduced-motion OS
   setting makes all warps instant cuts.

## 7. Admin CRUD

`https://keap.pazny.lab/admin` (as a `nos-admins` member):
- **Znalostní objekty** tab: create an object with type `recipe`, body containing
  `[[01.01.01.01]]` → saves, appears in the list with a link count, and as dust
  in the explorer after a reload.
- **Taxonomie** tab: set a content link (`kiwix:<zim>/A/<page>`) on a node →
  "Open in Kiwix" button appears in the SPA and `contentLink` resolves in
  `GET /agent/v1/taxonomy/node/<id>`.

## Known-good baseline (verified locally in the container, 2026-07-11)

| Check | Expected |
|---|---|
| `/api/health` unauth | 200 `{"success":true}` |
| `/api/me` headerless, `KEAP_TRUSTED_PROXY=1` | 401 |
| `/agent/v1/health` | `surface: enabled`, `taxonomyNodes: 790` |
| `meta.layoutVersion` | `v1:f99c46a4f3fbc805` (stable across restarts) |
| Node `01` position | `x=1400, y=0` |
| RO token POST /agent/v1/objects | 403 `write scope required` |
| Docker image | builds & runs as non-root; `/data` chown fix landed 2026-07-11 |

## 8. Taxonomy extension proposals (Track T, v0.6.0)

```bash
RW=<keap rw token>; B=http://127.0.0.1:8091
# anchor-core parent refuses:
curl -s -X POST -H "Authorization: Bearer $RW" -H 'content-type: application/json' \
  $B/agent/v1/taxonomy/propose -d '{"parentId":"08","name":"X","description":"a sufficiently long description here"}'
  # → 400 "ANCHOR CORE … changes only by release"
# missing description refuses with the doctrine:
curl -s -X POST -H "Authorization: Bearer $RW" -H 'content-type: application/json' \
  $B/agent/v1/taxonomy/propose -d '{"parentId":"02.02.02.05.04","name":"Hypergraphs"}'
  # → 400 "descriptions are load-bearing … (DescGraph doctrine)"
# votable parent queues; approve in Admin › Moderation (badge "new node") →
# node materializes with the next numeric id, appears in search + universe
# IMMEDIATELY; original stars must not move (compare /api/graph positions).
# A level-5+ parent auto-approves (free zone), recorded as decided_by
# auto:free-zone. Restart: no re-bake, grown stars persist.
```

## 9. OKF bundle roundtrip (S3, v0.6.0)

```bash
# Two dev instances (SOURCE seeded, TARGET on an EMPTY data dir; avoid :8099 — Bone owns it):
node deploy/smoke-okf-roundtrip.mjs   # SOURCE=… TARGET=… env-overridable
# expected: import {queued:N, errors:[]} → approve N → "OK: N card(s) identical"
# re-import the same bundle → {queued:0, skippedIdentical:N} (id+content_hash dedupe)
# Bundle layout objects/<type>/<slug>-<id8>.md is OKF v0.1 conformant
# (only required key: type) — readable by the openknowledge CLI.
```

## 10. K1 taxonomy-describe (curated descriptions, post-v0.6.0)

```bash
RO=<ro token>; RW=<rw token>; B=http://127.0.0.1:8091
# intake: server-assembled context, 778 nodes lacked descriptions at ship
curl -s -H "Authorization: Bearer $RO" "$B/agent/v1/taxonomy/describe/pending?limit=3"
  # → {total, items:[{id,name,path,zone,childNames,siblingNames}]}
# batch propose (en canonical + cs localization; <20 chars → per-item error):
curl -s -X POST -H "Authorization: Bearer $RW" -H 'content-type: application/json' \
  $B/agent/v1/taxonomy/describe -d '{"items":[{"nodeId":"01.01","descriptionEn":"…20+ chars…","descriptionCs":"…20+ chars…"}]}'
# moderate: Admin › Moderation shows kind=desc rows + a BULK approve bar
# (or POST /api/promotions/decide-desc-bulk {"decision":"approve"}).
# consumers flip in the same step (llms.txt lesson):
#   /api/graph node carries description + descriptionCs,
#   /agent/v1/taxonomy/search finds words FROM the description,
#   /agent/v1/embeddings/pending marks the node stale (content_hash),
#   describe/pending total shrinks.
# invariants: layout_version UNCHANGED (descriptions are metadata — stars
# never move), override survives restart (node_descriptions table).
```
