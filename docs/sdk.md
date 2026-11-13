# Build from TypeScript

Use the SDK when you need to integrate build admission, progress or results into your own tool. For command-line builds, use the [native](../examples/gradle/README.md) or [Expo](../examples/expo/README.md) guide instead.

These APIs require the [unpublished candidate](install.md). `createBuilder()` manages receipt IDs and provider lifetime; preparation never allocates a host.

## Prepare, review and start

```ts
import { createBuilder } from '@firtoz/android-builder';
const builder = createBuilder({ receiptsDirectory: '/private/builds' });
const build = await builder.prepare({
  root: '.',
  config: { project: { kind: 'gradle' }, admissionAllowanceUsd: 0.20 },
  licensesDirectory: '/private/accepted-sdk-licenses',
});
console.log(await build.inspect()); // persist/display ID and receipt; review first
await build.start({ admitUsd: 0.20, waitForCompletion: false });
const result = await build.wait();
if (result.outcome === 'succeeded') {
  console.log(await build.exportArtifact(`/approved/${build.id}.apk`));
} else {
  console.error(result.work, result.cleanup, result.issues, result.nextCommand);
  process.exitCode = 1;
}
```

Keep the printed ID and receipt directory on private durable storage. `receiptsDirectory` selects the parent for generated UUID directories; an explicit `directory` can be passed to `prepare` instead. Review the frozen plan before calling `start`: that call is the spending admission boundary.

## Start asynchronously and list recent builds

```ts
await build.start({ admitUsd: 0.20, waitForCompletion: false });
console.log(await builder.list({ limit: 20 })); // offline receipt history
// In a later process, reconnect to the same ID/directory and observe it.
```

This returns only after acknowledged launch. The remote job runs within its original lease; no local daemon downloads artifacts or retires the host for you. A later `observe()` must retrieve/verify the APK and finish owned cleanup before lease expiry. An uncertain launch remains a typed error, not a successful async submission. The default `start` still waits through retrieval and cleanup.

`builder.list()` reads direct child receipt journals under its configured parent, newest first. It performs no provider calls or mutations and reports unreadable/incomplete journals in `issues`. The default limit is 20, valid limits are 1–100, and scanning is bounded to 1,000 parent entries. It exposes recorded state rather than remote liveness or a new local-artifact hash check. `listBuilds(parent, { limit })` is available as an independent offline helper. [Expo handoff](expo.md).

## Reconnect and retrieve

```ts
const same = await builder.reconnect({ id: savedId }); // same receiptsDirectory
// Or: await builder.reconnect({ directory: savedDirectory });
console.log(await same.inspect()); // offline, no adapter open
await same.observe();             // observe/retrieve/finish cleanup; never launch
const apk = await same.artifact(); // recheck current local bytes
```

Use the saved ID from the previous operation, not a new one. A pre-launch interruption requires explicit `start({ admitUsd })` on that same handle. After a lost launch acknowledgement, only observation is allowed; launch is never replayed. `retire()` deliberately releases a positively owned host and can destroy an unretrieved artifact. [Recovery and error codes](operations.md).

## Progress, cancellation and outcomes

`start` and `observe` accept `signal: AbortSignal`, `log(bytes)` and `progress(journal)` callbacks. Embedded applications own process signal policy; the CLI handles SIGINT/SIGTERM itself. Cancellation stops observation and may leave remote compilation running.

Operations open and close the adapter even on failure. A `BuildOperationError` contains a typed `code`, build ID, receipt, next safe command, and separate work/cleanup outcomes. A `BuildPreparationError` carries the generated ID, intended directory and next command; early input failures may precede report creation. `inspect()` returns recorded evidence; `artifact()` verifies the current local APK bytes. A valid artifact can coexist with unconfirmed retirement.

## Wait for a typed result and export

`wait()` observes/retrieves/finishes owned cleanup without allocating or launching, and returns a `BuildCompletion`: `succeeded`, `failed` or `needs-attention`. Work, cleanup and current verified-artifact metadata remain separate. Known runtime issues are returned as typed `issues`; unreadable local receipts and unexpected local errors can still throw. Existing `observe()` keeps its throwing behavior. `start()` also retains typed errors for submission/admission; follow those errors using the same durable identity.

`exportArtifact(destination)` rechecks bytes and atomically exports an APK without provider credentials or raw journal parsing. It accepts identical existing content on retry, refuses different content and receipt-internal destinations, and returns a `VerifiedArtifact` descriptor with build ID, byte length, SHA-256, expected application ID and source hash. It can export a valid artifact while cleanup remains unresolved; your application must still report that cleanup. [Automation contract and CI commands](automation.md).

## Configuration and application policy

`defineProjectConfig` supplies typed intent; frozen files supply conventional values and their provenance. `defineBuildConfig` and the low-level prepare/run/retire/transport exports remain available for integrations that need them. [Configuration reference](configuration.md) · [Provider configuration](providers.md).

Your application still owns deployment profiles, validation of public environment/input content, final IDs for dynamic configs, trusted-source admission, account permissions, aggregate budget/reservation accounting, signing authorization and release decisions. A stricter source `include` filter is supported; preparation checks the resulting frozen selection for completeness.
