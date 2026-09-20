# Planner and Agent gateway regression fixes

Base: `1cb82f6fb902f156faaba1fbdb09a30017386805`.

## Changes

- Configuration inspection and underspecified configuration requests no longer invent a view-distance write of 10.
- Respect clause-local Chinese/English negations for lifecycle operations, installations and EULA consent.
- Explicit read-only tool hints and plugin installation context no longer accidentally trigger server installation.
- Remove the legacy pinned Paper download branch that incorrectly used logs.query with download arguments.
- Require a signed hello before processing Agent messages and bind each connection to its hello identity.
- Reject task events not owned by the sending Agent and inventory collisions with other Agents.
- Closing a replaced socket no longer marks the replacement connection offline.
- Handle asynchronous task event failures and add Python plus standalone planner checks to CI.

## Local validation

- Original planner: standalone suite reproduced 11 failures out of 16 cases.
- Original Agent gateway: new signed-message suite reproduced 5 failures out of 6 cases.
- Fixed Cloud: 61 tests passed, including 20 new regression cases.
- Standalone planner suite: 16/16 passed (overlaps Vitest coverage; not additional unique coverage).
- Python/LangGraph: 88 tests passed.
- Contracts, Cloud and Web typecheck passed.
- Contracts, NestJS and Next.js production builds passed.

The Agent gateway tests use real Ed25519 signatures with in-process socket doubles.
Model tests use the repository's fake providers; they are not live-provider acceptance tests.
Go is not installed in the local execution environment; the existing CI Go job must verify it.
No test-server SSH session or Minecraft mutation was performed. Server-local changes not yet
synced to GitHub are outside this patch. This is a targeted bugfix, not a claim that all bugs are resolved.
