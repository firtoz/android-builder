# Upgrade from 0.1.0

Use this guide for an existing integration. New users should start with the [native](../examples/gradle/README.md) or [Expo](../examples/expo/README.md) example.

The `0.2.0-dev.0` candidate is unpublished; [install it from this checkout](install.md). Keep the complete private receipt directories of existing builds. Do not re-prepare interrupted work as part of an upgrade.

## Update CLI callers

| Existing operation | Preferred operation |
| --- | --- |
| `run --directory PATH --max-usd N` | `start --directory PATH --admit-usd N`; aliases remain supported |
| `status --directory PATH` | `inspect --directory PATH`; offline evidence only |
| Re-run `run` after launch interruption | `observe --directory PATH`; never allocates or launches |
| Parse unversioned stdout | Use `--json` and check the versioned envelope and `error.code` |

Human output is now the default. JSON goes to stdout; progress and compiler logs go to stderr. Preserve nonzero exit codes. A verified artifact with unresolved retirement must still be reported as needing cleanup. [Output and failure contract](operations.md#erroroutput-contract).

## Update SDK/configuration callers

The low-level `defineBuildConfig`, `prepareBuild`, `readJournal`, `runBuild`, `retireBuild`, `boatTransport` and signing/install exports remain available. You can adopt [createBuilder](sdk.md) to manage generated receipts and adapter lifetime without rewriting lower-level integrations immediately.

`defineProjectConfig` accepts project intent and derives conventional values from frozen files. It uses `admissionAllowanceUsd`; the resolved legacy config retains `reservationUsd`. `defineBuildConfig` still immediately parses an explicit low-level configuration. Do not send unresolved intent to host/provider APIs.

New preparations using either form check required inputs, lockfiles, local dependencies/workspaces, unsupported source types and static configuration conflicts. Previously omitted inputs can now fail before allocation. Dynamic/flavored projects need explicit final identity/output settings. [Configuration reference](configuration.md).

## Reconnect existing receipts

Version-1 receipts remain readable and recoverable, using their original frozen scripts/configuration. New journal fields have safe defaults. A receipt without provider metadata uses the historical Boat Large default.

Finish old custom-provider receipts through the low-level integration that created them. New custom-provider builds record their settings identity through `createBuilder({ provider })`. Never hand-edit provider metadata or discard the provider database to bypass ownership checks. [Providers](providers.md) · [Recovery](operations.md).

## If you remain on published 0.1.0

Use its explicit native configuration and legacy commands rather than candidate examples:

```ts
import { defineBuildConfig } from '@firtoz/android-builder';
export default defineBuildConfig({
  project: { kind: 'gradle' },
  artifact: 'app/build/outputs/apk/debug/app-debug.apk',
  applicationId: 'org.example.hello', // replace with your app's final ID
  reservationUsd: 0.20,
});
```

```sh
npx android-builder prepare --config android-builder.config.ts \
  --licenses /private/accepted-sdk-licenses --directory ./build-receipt
npx android-builder status --directory ./build-receipt
# After reviewing the frozen inputs and supplying controller-only BOAT_API_KEY:
npx android-builder run --directory ./build-receipt --max-usd 0.20
```

Resume interrupted work using that same receipt and original integration. An operator allowance is not a price quote or aggregate cap, in either version.
