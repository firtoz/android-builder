# Android Builder

Build Android debug APKs on disposable Linux VMs without installing an Android toolchain on your laptop. Prepare and review the source first, explicitly authorize a build, and reconnect to retrieve the verified APK if your terminal or CI job is interrupted.

Use it for native Gradle apps or Expo prebuild when you want remote compute while keeping provider credentials off build machines and signing keys separate. The same CLI and TypeScript SDK work locally and in CI. Receipts preserve the build identity, logs and recovery state; uncertain launches are never repeated automatically.

**Version:** this checkout documents the unpublished `0.2.0-dev.0` candidate. The npm release `0.1.0` uses a different workflow. Follow the checkout trial below or [upgrade an existing integration](docs/migration.md).

## Why use it with Expo?

Keep Expo app configuration, prebuild and Metro; choose Android Builder for the native compile when you want control over the VM, explicit per-build admission, frozen-input review and private recoverable build receipts. You can return to Expo's development tools with the completed APK.

| Step | Standard EAS Build workflow | Android Builder workflow |
| --- | --- | --- |
| Start asynchronously | `eas build --platform android --profile development --no-wait` | Prepare/review, then `android-builder start --directory PATH --admit-usd 0.20 --no-wait` |
| Where compilation happens | Expo's managed build infrastructure | Your selected dedicated VM: Expo prebuild, then Gradle |
| Recent builds and progress | Expo dashboard / `eas build:list` | `android-builder list` reads private receipts; optional `eas workflow:runs` shows configured controller jobs; `observe` refreshes/retrieves |
| Completed APK | EAS download/distribution tools | Exactly verified local APK; optional signing/install and manual Orbit handoff |
| Continue app development | Install development build, use Metro | Same Expo development tools when the app includes a compatible dev client |
| Scope | Managed Android/iOS builds, signing and release workflows | Android debug APKs; signing separate; current candidate has offline qualification |

Both workflows are asynchronous. EAS also has caching and development-build reuse; Android Builder is useful for compute/recovery control rather than an assumed speed advantage. JavaScript-only iteration through Metro usually needs no native rebuild in either workflow. [Expo Build features](https://docs.expo.dev/build/introduction/) · [CLI commands](https://docs.expo.dev/eas/cli/) · [Development workflow](https://docs.expo.dev/develop/development-builds/introduction/).

**Expo handoff:** A custom Expo Workflow can track the controller job and attach the completed APK as a generic run artifact; compilation stays on the Android Builder VM. This is an optional, unqualified integration recipe, not a native EAS build-history import. Orbit can open the local APK. [Workflow artifact contract](https://docs.expo.dev/eas/workflows/syntax/#easupload_artifact) · [Expo Orbit](https://docs.expo.dev/build/orbit/) · [Complete Expo/async workflow](docs/expo.md).

## Measured build times

| Historical workload | Android Builder `0.1.0`, cold VM to verified APK **and retirement** | Matched EAS result |
| --- | ---: | --- |
| Minimal native debug app | 1 min 25 s | Not measured |
| Minimal Expo debug app | 4 min 46 s | Not measured |

These include allocation, setup, compilation, download and cleanup on fresh Boat Large hosts. They are two different workloads, not a relative speed benchmark, and do not qualify the changed candidate or a full Expo development client. We cannot claim “faster than EAS” from these results. [Measurements and limits](maintainer/qualification.md) · [Fair-comparison method](maintainer/benchmarks.md).

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

For a start-and-return workflow, add `--no-wait` to `start`, then run `observe` later to retrieve the APK and finish cleanup before lease expiry. `list` shows recent builds under `.android-builds` (or `--receipts-directory PATH`); custom receipts such as `./build-receipt` must be listed through their parent. [Async Expo guide](docs/expo.md).

After interruption, keep the same receipt and run `observe --directory ./build-receipt`. Ctrl-C stops observation; remote compilation may continue. If work had not reached launch, explicitly `start` the same receipt again. A verified artifact and unconfirmed retirement can coexist. Never delete receipts or choose a new ID to recover uncertainty. [Recovery and cleanup](docs/operations.md).

## Use it in your project

| Your next task | Guide |
| --- | --- |
| Choose inputs, toolchain, tasks or ABIs | [Configuration](docs/configuration.md) |
| Build asynchronously and return to Expo | [Expo workflow](docs/expo.md) |
| Build from a monorepo | [Monorepo recipe](docs/monorepo.md) |
| Build in a trusted CI job | [CI recipe](docs/ci.md) |
| Automate typed completion and verified artifact handoff | [Automation API and CLI](docs/automation.md) |
| Integrate with a TypeScript tool | [SDK](docs/sdk.md) |
| Change the machine or provider adapter | [Providers](docs/providers.md) |
| Sign an APK or install on an existing device | [Signing and install](docs/signing.md) |

For programmatic use, `build.wait()` returns a compact typed completion and `build.exportArtifact(path)` supplies a verified, retry-safe APK plus metadata. Integrations do not need to parse provider journals or copy APKs themselves. [SDK](docs/sdk.md) · [Automation contract](docs/automation.md).

Build only trusted source: dedicated build VMs have network access and sudo, not sandbox-runtime attestation. Preparation uses selected Git-tracked working-tree bytes, including edits; ordinary untracked/hidden inputs are omitted. Review the report—it is not a secret scanner or a complete dependency resolver. Keep receipts private and durable.

The current scope is debug APKs. Production releases, AAB/store distribution, device launch and alternative providers are not qualified. The candidate has offline checks; earlier live Android builds apply to `0.1.0`. [Support and verification status](docs/qualification.md).

MIT licensed. To work on Android Builder itself, start in [maintainer/](maintainer/README.md); package users can skip it.
