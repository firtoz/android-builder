# Android Builder

Build Android debug APKs on disposable Linux VMs without installing an Android toolchain on your laptop. Prepare and review the source first, explicitly authorize a build, and reconnect to retrieve the verified APK if your terminal or CI job is interrupted.

Use it for native Gradle apps or Expo prebuild when you want remote compute while keeping provider credentials off build machines and signing keys separate. The same CLI and TypeScript SDK work locally and in CI. Receipts preserve the build identity, logs and recovery state; uncertain launches are never repeated automatically.

**Version:** this checkout documents the unpublished `0.2.0-dev.0` candidate. The npm release `0.1.0` uses a different workflow. Follow the checkout trial below or [upgrade an existing integration](docs/migration.md).

## Give it a try

You need Linux, Node **24.22.1+**, Git and tar. From this checkout, inspect the CLI without cloud credentials or spending:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
```

Then follow one complete example:

- [Native Gradle app](examples/gradle/README.md): a small Java app with no JavaScript runtime.
- [Expo app](examples/expo/README.md): generate the Android project and build a debug APK for the normal Metro/development workflow.

Both guides start with an isolated app repository and the [candidate installation instructions](docs/install.md). Preparation needs a directory of SDK license hashes you have **already accepted**, but no local Android SDK, Java, Gradle, NDK or CMake. [How to supply accepted licenses](docs/configuration.md#sdk-licenses).

## From source to APK

Once installed in your app, use a minimal native configuration:

```ts
import { defineProjectConfig } from '@firtoz/android-builder';
export default defineProjectConfig({
  project: { kind: 'gradle' },
  admissionAllowanceUsd: 0.20,
});
```

```sh
npx android-builder prepare --config android-builder.config.ts \
  --licenses /private/accepted-sdk-licenses --directory ./build-receipt
npx android-builder inspect --directory ./build-receipt
# Review the frozen inputs and resolved settings before starting.
# Supply BOAT_API_KEY privately to the controller for the next command.
npx android-builder start --directory ./build-receipt --admit-usd 0.20
```

A successful start retrieves `build-receipt/artifact.apk`, verifies its exact length and SHA-256, and retires the owned VM. The host also checks the APK signature, expected application ID and any requested ABI set.

`0.20` is an example **operator-supplied per-build admission allowance**, not a provider quote, account-wide cap or invoice guarantee. The default machine is Boat Large with a one-hour lease; cold setup, execution and transfer all consume that lease. [Configuration and lease planning](docs/configuration.md#resolved-values).

After interruption, keep the same receipt and run `observe --directory ./build-receipt`. Ctrl-C stops observation; remote compilation may continue. If work had not reached launch, explicitly `start` the same receipt again. A verified artifact and unconfirmed retirement can coexist. Never delete receipts or choose a new ID to recover uncertainty. [Recovery and cleanup](docs/operations.md).

## Use it in your project

| Your next task | Guide |
| --- | --- |
| Choose inputs, toolchain, tasks or ABIs | [Configuration](docs/configuration.md) |
| Build from a monorepo | [Monorepo recipe](docs/monorepo.md) |
| Build in a trusted CI job | [CI recipe](docs/ci.md) |
| Integrate with a TypeScript tool | [SDK](docs/sdk.md) |
| Change the machine or provider adapter | [Providers](docs/providers.md) |
| Sign an APK or install on an existing device | [Signing and install](docs/signing.md) |

Build only trusted source: dedicated build VMs have network access and sudo, not sandbox-runtime attestation. Preparation uses selected Git-tracked working-tree bytes, including edits; ordinary untracked/hidden inputs are omitted. Review the report—it is not a secret scanner or a complete dependency resolver. Keep receipts private and durable.

The current scope is debug APKs. Production releases, AAB/store distribution, device launch and alternative providers are not qualified. The candidate has offline checks; earlier live Android builds apply to `0.1.0`. [Support and verification status](docs/qualification.md).

MIT licensed. To work on Android Builder itself, start in [maintainer/](maintainer/README.md); package users can skip it.
