# Support and verification status

Use this page to decide whether the supported outcome fits your project.

| Version | Evidence | Limit |
| --- | --- | --- |
| Unpublished `0.2.0-dev.0` candidate | Offline recovery/source/CLI tests, fresh package installs, strict SDK/example types and source preparation | No new real Android compilation or hosted-provider qualification for the changed candidate |
| Released `0.1.0` | Hosted native/Expo debug builds and two larger workloads, exact artifact/source checks and confirmed owned-host disappearance | Applies to those frozen sources/configurations, not all projects or later changes |

The current workflow targets trusted native Gradle and Expo prebuild projects producing one debug APK. The default provider is Boat Large. [Supported inputs/configuration](configuration.md).

An Expo debug APK generally needs the normal Metro/development workflow. Production JS bundles, development-client behavior, release AAB/store distribution, device/emulator launch, iOS, alternative providers and cache-performance guarantees are not qualified. Optional signing/install commands have separate local requirements; they do not establish store-release readiness.

Exact transfer hashes establish consistency with the recorded host outcome. They do not independently prove a malicious project's compiler/tooling behavior: build only trusted source, keep provider credentials on the controller, and keep signing separate. [CI trust boundary](ci.md).

If you need the measurements, material failed result or methods behind these claims, see the optional [maintainer qualification record](../maintainer/qualification.md). No current pricing or spending authorization follows from historical usage.
