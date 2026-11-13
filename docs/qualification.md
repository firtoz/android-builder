# Initial live qualification

November12,2026: one native Java/Gradle example and one minimal Expo example, each on a fresh, dedicated Boat Large host. This is functional qualification of different workloads, not a matched provider/service benchmark or a general speed guarantee. The same generic source/SDK/controller built both. No snapshots or shared cache service were used.

| Observation | Native Gradle | Expo |
| --- | ---: | ---: |
| Allocation through verified download and retirement | 85.20s | 286.22s |
| System tools installation | 39.16s | 41.62s |
| Android SDK packages | 4.47s | 15.40s |
| Project dependency install | Not needed | 4.28s |
| Expo prebuild | Not needed | 0.31s |
| Gradle | 23.38s | 193.52s |
| Verified APK bytes | 6,625 | 135,728,431 |
| Uploaded frozen input bytes | 17,122 | 68,895 |
| Host control commands | 23 | 62 |

The end-to-end clock starts immediately before the frozen build's allocation/observation and ends after verified download and provider404. Controller preparation and npm lock resolution are outside it. Download/archive checks include exact SHA-256, APK signature/application verification on the host and independent local ZIP/manifest/dex integrity. Per-stage rows overlap the enclosing build stage; do not sum them with that stage. Command counts exclude other provider HTTP requests.

Both sources were retired only after verified artifacts were acknowledged. Complete inventory subsequently showed zero active machines. Across this window the account meter increased739weighted seconds, or$0.00739of included compute at the reported100,000seconds/dollar. Wallet balance did not decrease. Included credits have value; this is not a new cash invoice, an account-wide audit or a promise of free builds. A conservative operator reservation remains separate from these measurements.

One local qualification-driver import failed before allocating a machine because the example's independent package boundary could not resolve an uninstalled controller package. The driver was corrected, its failed setup retained and the same frozen identity continued; it consumed no failure host. No failed Android compile was relabeled as a success.

The finite offline suite has13tests covering lost launch acknowledgements, stable replay, changed inputs, failed compilation, corrupt/partial transfers, exclusive controllers, expired leases, uncertain cleanup and the actual host claim/stage process. A packed package was installed independently for strict TypeScript consumer checks, both example configurations, SDK/CLI imports and local SQLite startup. Those fixtures do not replace the hosted Android builds.

These are debug APKs. The Expo debug build expects the normal development/Metro workflow; this does not establish a self-contained release JS bundle. Device/emulator launch, release AAB, store distribution, iOS, alternative host providers, warm caches and general cold-start comparisons are not qualified by these results. Application-specific consumer checks are separate and contain no private data in this repository.

## Released-package consumer qualification

Version0.1.0 is published on npm. An anonymous registry installation passed strict TypeScript consumption, SDK/CLI/adapter imports, real local SQLite startup and both example configurations. The registry integrity matches the approved tarball attached to the immutable v0.1.0 source release. These local checks do not allocate hosts.

Two larger, independently configured consumers then used the released package:

| Observation | Consumer A | Consumer B |
| --- | ---: | ---: |
| Allocation through verified download and retirement | 636.57s | 778.41s |
| Gradle | 513.27s | 618.97s |
| Verified APK bytes | 279,570,681 | 76,972,600 |
| Android ABIs | Four | One |

These are different applications and build configurations, not a matched speed comparison. Independent local APK checks covered exact hashes, ZIP integrity, expected application identity and ABI sets. Frozen input inventories were independently compared for exact selected bytes and executable modes.

One additional host failed during dependency installation: a consumer's source filter omitted its tracked local dependency archive. The failure and original identity were retained; that consumer now checks local file dependencies against its actual frozen source selection before allocating. One affected retry passed. This is a consumer preflight, not a claim that the generic SDK resolves every package-manager dependency.

Across the complete five-start window (four successful compiles and that failed setup), all five owned hosts independently returned404 and final account inventory had zero active machines. The shared account meter increased3,745weighted seconds, worth$0.03745of included compute; observed wallet debit was$0. No top-ups or snapshots were used. This is a bounded shared-account measurement, not a provider invoice or a recurring price guarantee. Earlier example-only usage is a subset, not an additional charge.

No new signing, device installation or backend deployment was part of these consumer builds. They retain the debug/Metro and release-coverage limitations above. Documentation after v0.1.0 does not change its published executable artifact.
