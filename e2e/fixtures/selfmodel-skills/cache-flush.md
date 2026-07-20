---
type: skill
title: cache-flush
---
Flush a namespace of the shared key-value cache.

Trigger: "flush cache", "invalidate cache", "clear redis keys"
Method: redis-cli --scan then DEL, scoped to one prefix

Part of [[nos.infra.redis]].
