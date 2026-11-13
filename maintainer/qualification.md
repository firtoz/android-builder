# Qualification evidence

Use these records to judge a specific version/workload or choose a future qualification test. For the current supported scope, read [verification status](../docs/qualification.md). These are bounded observations, not speed or pricing guarantees.

## 0.1.0: hosted debug builds — November 12, 2026

The released implementation built one generic native Java/Gradle app and one minimal Expo app on separate fresh Boat Large VMs. Both used the same controller/host code, with no snapshots or shared caches.

| Observation | Native Gradle | Expo |
| --- | ---: | ---: |
| Allocation through verified download and retirement | 85.20 s | 286.22 s |
| System tools installation | 39.16 s | 41.62 s |
| Android SDK packages | 4.47 s | 15.40 s |
| Project dependency installation | Not needed | 4.28 s |
| Expo prebuild | Not needed | 0.31 s |
| Gradle | 23.38 s | 193.52 s |
| Verified APK bytes | 6,625 | 135,728,431 |
| Uploaded frozen input bytes | 17,122 | 68,895 |
| Host control commands | 23 | 62 |

The end-to-end clock began immediately before allocation/observation and ended after exact verified download and provider 404. Controller preparation and npm lock resolution were outside it. Stage timings overlap the enclosing build stage and must not be summed with it. Control-command counts exclude other provider HTTP requests. These are different workloads, not a matched benchmark.

Checks covered exact source/APK hashes, APK signature/application verification on the host, and independent local ZIP/manifest/dex integrity. Hosts were retired after verified artifact acknowledgement; subsequent inventory showed no active machines.

### Larger workloads and a material failure

Two independently configured consumers used the published package:

| Observation | Consumer A | Consumer B |
| --- | ---: | ---: |
| Allocation through verified download and retirement | 636.57 s | 778.41 s |
| Gradle | 513.27 s | 618.97 s |
| Verified APK bytes | 279,570,681 | 76,972,600 |
| Android ABIs | Four | One |

Their exact source, APK bytes, executable modes, expected identities and ABI sets were checked. Different apps/configurations make these results unsuitable for speed comparisons.

One additional host failed in dependency installation because a consumer filter omitted a tracked local dependency archive. Its failed outcome and original identity were retained; an explicitly new affected build passed after a pre-allocation completeness check was added. Across all five starts—four successful compiles and that failure—all owned host IDs returned 404 and final inventory had zero active machines. This is the concrete reason to check the frozen manifest rather than disk existence; it is not evidence of universal package-manager resolution.

Across that complete shared-account window the meter increased 3,745 weighted seconds, reported as $0.03745 of included compute; observed wallet debit was $0. The example-only subset was 739 seconds/$0.00739 and is not an additional charge. Included credits have value. These are bounded meter observations, not an invoice, account-wide audit, price quote or future allowance.

### Release integrity and limits

An independent registry install checked SDK/CLI/adapter imports, local SQLite startup, strict TypeScript consumers and both example configurations. Registry integrity matched the approved tarball attached to the immutable `v0.1.0` source release. Its original offline suite had 13 focused recovery/source/launcher cases.

All Android outputs were debug APKs. Expo required its normal Metro/development workflow. Device/emulator launch, a self-contained production JS bundle, release AAB, stores, iOS, alternative providers and warm-cache performance were not qualified. No signing or backend deployment was part of these builds. Private receipts and consumer-specific details remain outside public documentation.

## 0.2.0-dev.0: offline candidate checks — November 13, 2026

The candidate changes source diagnostics, high-level APIs, CLI behavior and host ABI arguments. Earlier live results do not qualify those changes or the updated example sources. No new paid host or real Android compilation is part of this candidate evidence.

On Node 24.22.1, `npm run check` passed build/types, 26 recovery/preparation/CLI tests and lint. Fresh packed installs checked SDK/provider/CLI exports, SQLite open/close, strict public API types, native/Expo configuration, Expo TSX, both frozen preparations and offline JSON. App/controller types used separate appropriate globals with `strict: true` and `skipLibCheck: false`.

The package fixture deliberately keeps its local controller tarball inside frozen source: an external `file:` target is a real missing-input error, including in dev dependencies. Test install scripts are disabled; simulated APKs establish no Android compilation result. Current documentation/link/package checks are described in [development](development.md); their results must not be reported as live qualification.
