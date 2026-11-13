# Working on Android Builder

This area is for contributors changing Android Builder itself. If you want to build an app, use the [main README](../README.md) and task guides instead; you can skip this folder.

- [Development and verification](development.md): local checks, package validation and what the tests establish.
- [Architecture and provider contracts](architecture.md): recovery invariants and the upstream host-only API constraint.
- [Performance comparison method](benchmarks.md): align sources/outcomes and measurement boundaries before making relative claims.
- [Qualification evidence](qualification.md): reproducible methods, measured results, material failures and their limits.
- [Active CI integration handoff](ci-integration-plan.md): implementation sequence, existing SDK foundation and acceptance gates for asynchronous Expo/Android CI.

Keep this area curated. Retain decisions or evidence that can change an implementation or support decision; leave completed plans, raw prompts, process handles, routine receipts and chronological work narration to version control or private operational storage. Put current user instructions in `docs/` and examples beside their source. Never treat a historical test allowance as authorization for a new paid build or publication.
