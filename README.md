# Android Builder

Recoverable Android APK builds on disposable Linux compute. Use the same typed configuration from your laptop or CI; keep provider credentials on the controller and sign artifacts separately.

The standalone Expo and native Gradle examples have each compiled on fresh Boat Large hosts, with hash-verified APK downloads and confirmed host retirement. [Measured results and limits](docs/qualification.md). Core recovery tests use simulated hosts and the real one-shot launcher; consumer integrations and broader release profiles remain separate qualification.

## Use it

Use Node 24.22.1 or newer on Linux. Your source must be in Git, and you must supply SDK license hashes you have already accepted. Nothing accepts SDK terms automatically. The initial host bootstrap expects an x86-64 Debian/Ubuntu machine with passwordless `sudo` and outbound HTTPS; Boat Large is the initial adapter configuration.

Install with `npm install --save-dev @firtoz/android-builder`. For development before a release reaches the registry, run `npm run build && npm pack` in this checkout and install the local tarball.

```ts
// android-builder.config.ts
import { defineBuildConfig } from '@firtoz/android-builder';

export default defineBuildConfig({
  project: { kind: 'expo', directory: '.' },
  packageManager: { kind: 'npm', version: '11.10.1' },
  toolchain: { ndk: '27.1.12297006', cmake: '3.22.1' },
  artifact: 'android/app/build/outputs/apk/debug/app-debug.apk',
  applicationId: 'org.example.hello',
  reservationUsd: 0.20,
});
```

```sh
npx android-builder prepare --config ./android-builder.config.ts \
  --licenses "$ANDROID_HOME/licenses" --directory ./build-receipt
# Review build-receipt/source-manifest.json and its frozen inputs first.
# BOAT_API_KEY comes from your controller/CI secret store, not the source archive.
npx android-builder run --directory ./build-receipt --max-usd 0.20
```

Preparation reads safe Git-tracked working-tree bytes, including tracked local edits. Untracked files are omitted; add intended source files to Git first. It excludes hidden paths, dependency/output directories and common credential files. This filtering is not a secret scanner: review the frozen manifest. Explicit public inputs can supply optional files such as Firebase client configuration; signing keys and service-account keys are never build inputs.

A successful run downloads `artifact.apk`, verifies its length and SHA-256, persists its receipt and retires the owned host. A disconnect retains the same directory and identity: run the same command again to observe existing work. Never prepare a new identity merely because a response was lost. `status` is local; `retire` explicitly releases only that build's owned machine. Process RAM, shared caches and warm pools are outside this version.

The reservation is an operator-supplied conservative per-build allowance, **not a provider price estimate, account-level cap or invoice**. It must cover the chosen host's full lease, possible start fees and transfers. The default lease is one hour; observation stops before its expiry. A failed or uncertain transfer retains the source until explicit retirement or provider expiry. Keep the receipt directory private and on durable controller storage; losing it can make work unobservable even though the bounded lease still expires.

## Embedded API

```ts
import { prepareBuild, runBuild } from '@firtoz/android-builder';
import { boatTransport } from '@firtoz/android-builder/providers/boat';
import config from './android-builder.config.ts';

const directory = './build-receipt';
await prepareBuild({ root: '.', directory, config, licensesDirectory: '/path/to/sdk/licenses' });
const host = boatTransport(directory, process.env.BOAT_API_KEY!);
try {
  const result = await runBuild(directory, host.transport, { maxUsd: 0.20 });
  console.log(result.artifactVerified);
} finally {
  host.close();
}
```

`BuilderTransport` is injectable. Adapters must persist allocation identities, enforce leases, verify ownership before retirement and bound transfers. The root SDK does not import the Boat/SQLite adapter. These are dedicated trusted-source build machines, not untrusted multi-tenant execution sandboxes.

## Examples and operations

- [Expo application](examples/expo/README.md)
- [Native Java/Gradle application](examples/gradle/README.md)
- [Lifecycle, recovery and CI](docs/operations.md)
- [Separate signing](docs/signing.md)
- [Qualification and remaining work](docs/goals/standalone-builder.md)

Run `npm install` and `npm run check` to develop this package. No cloud account or Android SDK is needed for its offline tests. MIT licensed.
