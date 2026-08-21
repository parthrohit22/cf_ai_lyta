# Change proposal: move session storage from in-memory cache to Redis

_This is a fictional sample document. "Northwind Analytics" is not a real
company; any resemblance to an actual system is coincidental. It exists as
safe, public sample material for demoing LYTA's file upload, retrieval, and
citation flow — and, once the Architecture Change Review workflow
([issue #10](https://github.com/parthrohit22/lyta/issues/10)) ships, as
sample input for that review._

## Problem statement

Northwind Analytics' API gateway currently keeps user session state in an
in-process LRU cache on each gateway instance. This works at today's scale
(3 gateway instances behind a round-robin load balancer) but has two known
issues:

- A user's session is only valid on the instance that created it unless the
  load balancer happens to route them back to it, causing intermittent
  forced re-logins.
- Restarting a gateway instance (deploys, autoscaling, crashes) silently
  drops every session it was holding.

## Proposed change

Replace the in-process LRU cache with a shared Redis instance (Amazon
ElastiCache, single-AZ to start) as the session store. Gateway instances
become stateless with respect to sessions; session reads/writes go through
a thin `SessionStore` interface that currently wraps the LRU cache and would
instead wrap a Redis client.

## Affected components

- `api-gateway` service: replace `LocalSessionCache` with `RedisSessionStore`
  behind the existing `SessionStore` interface — call sites are unaffected.
- Deployment: add a Redis connection string to gateway configuration; add
  the ElastiCache cluster to the VPC security group allowlist.
- Observability: add cache hit/miss and Redis latency metrics; existing
  session-count dashboards need a data-source change.

## Risks and open questions

- **Single point of failure**: a single-AZ Redis instance means a zone
  outage drops all sessions simultaneously, which is strictly worse than
  today's per-instance blast radius. Multi-AZ failover is proposed as a
  fast follow, not a launch blocker, given current traffic volume.
- **Latency**: every session read now costs a network round-trip instead of
  an in-process map lookup. Needs a load test before rollout to confirm p99
  gateway latency stays within budget.
- **Migration**: existing in-flight sessions on gateway instances are not
  migrated; users active during the cutover window will be logged out once.
  Proposed mitigation: deploy during the lowest-traffic window and announce
  a possible one-time re-login.
