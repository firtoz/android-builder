# Build from TypeScript

Use the SDK when you need to integrate build admission, progress or results into your own tool. For command-line builds, use the [native](../examples/gradle/README.md) or [Expo](../examples/expo/README.md) guide instead.

These APIs require the [unpublished candidate](install.md). `createBuilder()` manages receipt IDs and provider lifetime; preparation never allocates a host.

## Prepare, review and start

```ts
import { createBuilder, BuildOperationError } from '@firtoz/android-builder';
const builder = createBuilder({ receiptsDirectory: '/private/builds' });
const build = await builder.prepare({
  root: '.',
  config: { project: { kind: 'gradle' }, admissionAllowanceUsd: 0.20 },
  licensesDirectory: '/private/accepted-sdk-licenses',
});
const plan = await build.inspect(); // persist/display plan.id and plan.directory
// Review/authorize outside prepare. This explicit call is the spending boundary.
try {
  await build.start({ admitUsd: 0.20 });
  console.log(await build.artifact());
} catch (error) {
  if (error instanceof BuildOperationError) {
    console.error(error.code, error.build.id, error.build.nextCommand);
  }
  throw error; // do not convert failed compile/cleanup into a success
}
```

Keep the printed ID and receipt directory on private durable storage. `receiptsDirectory` selects the parent for generated UUID directories; an explicit `directory` can be passed to `prepare` instead. Review the frozen plan before calling `start`: that call is the spending admission boundary.

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

## Configuration and application policy

`defineProjectConfig` supplies typed intent; frozen files supply conventional values and their provenance. `defineBuildConfig` and the low-level prepare/run/retire/transport exports remain available for integrations that need them. [Configuration reference](configuration.md) · [Provider configuration](providers.md).

Your application still owns deployment profiles, validation of public environment/input content, final IDs for dynamic configs, trusted-source admission, account permissions, aggregate budget/reservation accounting, signing authorization and release decisions. A stricter source `include` filter is supported; preparation checks the resulting frozen selection for completeness.
