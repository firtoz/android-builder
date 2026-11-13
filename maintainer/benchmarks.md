# Compare build performance fairly

There is no matched EAS-versus-Android-Builder benchmark yet. Existing [measurements](qualification.md) concern different historical workloads. Keep README numbers scoped to their actual version/outcome and leave unmeasured competitor results explicitly blank.

Before any live comparison, obtain a separately scoped allowance for both providers, workload count, selected machines/plans, full leases and transfers. This document authorizes no cloud allocation or publication.

## Fix the workload and boundaries

Use one reviewed immutable source/lockfile and equivalent selected input manifests, Expo SDK/native dependency versions, Java/SDK/NDK/CMake, application ID, ABI set, Gradle task and artifact outcome. Compare debug to debug; a minimal Metro-dependent APK, a full dev client and a bundled release app are different workloads. Include expo-dev-client in both or neither. Verify that EAS profile defaults have not changed the task/signing/outcome.

Record source/input hashes and exact configuration for each run. Match credentials/signing policy without sending Android Builder's signing/provider keys to its build VM. Keep all receipts/logs private; export only reviewed summaries. A provider disappearance, compiler error, corrupt transfer or unconfirmed retirement remains an outcome, not a discarded sample.

## Measure useful intervals

| Interval | Start and end |
| --- | --- |
| Developer wait | Explicit admitted submission through a locally verified installable artifact; report allocation/queue, upload, cold setup, compile and download separately |
| Build service time | The same defined native-build stages on both services; state exclusions and overlaps |
| Cleanup | Verified retrieval through confirmed owned retirement for Android Builder; report separately from the developer wait boundary |
| Reuse | A separately labelled warm/reused-build case; never compare EAS cache/fingerprint reuse with an Android Builder cold compile as equivalent native work |

Report machine/plan/region, queue state, source upload bytes, APK bytes, all individual samples and the median/range for a bounded predeclared run count. Do not call a single run a general speed guarantee. Provider billing/included-credit observations are not a final invoice or account-wide cap.

The Android Builder history of 85.20 s native / 286.22 s Expo includes allocation through confirmed retirement. A future developer-wait comparison must align that boundary or explicitly separate cleanup; do not place those values beside an EAS compile-only number and derive a speed ratio.
