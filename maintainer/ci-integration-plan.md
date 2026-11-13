# CI integration implementation handoff

Audience: the next contributor implementing asynchronous Android/Expo CI integration. This is an active implementation plan, not a description of shipped capabilities. Keep it current during execution; remove it or replace it with lasting architecture/task guidance when the work is complete.

## Objective and starting point

Make Android Builder usable as the native compilation backend of an existing mobile CI pipeline. Preserve the developer experience: push a reviewed change, skip redundant work, publish an OTA update when compatible, otherwise build once asynchronously, follow progress, and receive a verified install link and completion notification. Keep the controller independent of the compute provider and of any one application.

The starting branch is `codex/expo-ci-handoff` in `https://github.com/firtoz/android-builder`. The package is an **unpublished** `0.2.0-dev.0` candidate; published `0.1.0` does not contain these APIs. Use this checkout, its lockfile and locally packed package, not an assumed npm release. Read repository `AGENTS.md`, [architecture](architecture.md), [SDK](../docs/sdk.md), [automation](../docs/automation.md), [CI trust/durability rules](../docs/ci.md), [Expo integration](../docs/expo.md) and [qualification boundaries](qualification.md) before editing.

Implemented foundation on this branch:

- `createBuilder({ receiptsDirectory, provider? })`, `prepare`, `reconnect`, and offline bounded `list`.
- A frozen-input preparation report, durable build identity and resolved configuration before remote effects.
- `build.start({ admitUsd, waitForCompletion: false })` / CLI `start --no-wait`: return after acknowledged launch. This starts no background controller daemon.
- `build.wait()` / CLI `wait --json`: reconcile the same operation, retrieve/verify its artifact, attempt positively owned cleanup, and return a compact typed `BuildCompletion`. Waiting never allocates or launches.
- `build.exportArtifact(destination)` / CLI `export --output`: reverify and atomically export local bytes, accept identical existing output, reject conflicting output/symlinks, and avoid provider credentials. Export requires a writable receipt lock and local hard-link/directory-fsync support.
- Work and cleanup outcomes remain separate. A verified APK can coexist with unresolved retirement; a failed compiler stays failed. Compact results still contain private operational metadata.
- Boat support uses **Android Builder → released Jetski → Boat VM**. These are layers. Other transports are injectable but not thereby qualified. Default compute is Boat Large.

Not implemented: shared controller service, external request-key deduplication, compatible native-artifact registry, artifact hosting, durable notification delivery, standalone Expo preview/release output parity, AAB/store/iOS support. Receipt history is local history, not a cloud dashboard or compatibility registry.

## Reference workflow to preserve

A real consumer pipeline was inspected read-only. Its behavior, distilled without application configuration, is the target:

1. GitHub push/PR jobs select an immutable source revision and application-owned profile/channel/public settings.
2. A task cache covers mobile source/configuration. A hit restores the previous result and does not submit another remote workflow.
3. On a miss, compute a native compatibility fingerprint. Search for a compatible binary under the selected profile/channel; join a matching build already in progress rather than submit a duplicate.
4. If a compatible native runtime exists, publish a JavaScript/assets OTA update through Expo Update. Otherwise compile a new native binary.
5. PR/staging submission returns promptly with a durable run ID and tracking URL. A separately durable observer continues after the GitHub submission job exits. Production may choose to wait.
6. Progress is correlated to the original GitHub run, source revision, PR and channel. Completion publishes install/update links, updates a PR comment and records a release for application update notices.
7. Closed previews, superseded revisions and stale completion events cannot republish an obsolete release. Terminal state cannot be overwritten by late progress.

An outer task-cache hit and an inner native-fingerprint match are different decisions: JavaScript changes can invalidate the task cache while still allowing OTA without a native compile.

## Architecture and boundaries

Retain the existing CI triggers, application policy and notifier where available. Replace native compilation behind a small generic integration contract. A trusted Linux/Node controller runs Android Builder; a serverless coordinator can call it or receive its events. Do not assume the Node/Git/tar/SQLite controller can execute unchanged inside a Worker/Durable Object.

Keep Expo prebuild and Expo Update where useful. Expo officially supports [Update independently of Build](https://docs.expo.dev/eas-update/standalone-service/); externally built apps need correct embedded update URL, runtime version and channel request headers. An `eas.json` profile alone does not automatically configure an external Gradle build. Verify current official documentation during implementation.

An Expo Workflows custom job may provide workflow tracking and a generic APK attachment. That attachment is **not** an EAS native build record, and EAS `get-build` cannot be assumed to discover it. Do not invent an unsupported build-registration API or undocumented GraphQL write. Our own artifact registry must support external builds. Native EAS history/deployment bookkeeping parity is not an acceptance promise. See [the current workflow fragment and its prerequisites](../docs/expo.md#track-the-job-in-expos-dashboard).

Keep application-specific identities, account settings, secrets, channel naming policy, release permissions and notification destinations in consumer configuration. No consumer imports, credentials, app names or private endpoint configuration enter this repository. Do not modify a consumer repository as part of this generic implementation. Any adoption there is separately scoped.

## Ordered implementation

### 1. Durable request identity and run contract

Implement the smallest useful controller integration around the existing SDK, not a second build engine. Prefer a library/reference controller and one generic CI example before adding a hosted product or an HTTP service without an actual deployment need.

- Define a versioned request/result contract: immutable source identity, resolved configuration identity, profile/channel context, native compatibility identity when available, build ID, sanitized phase/outcome, artifact digest/size/location, and cleanup state. Separate private recovery details from a deliberately public summary.
- Persist a stable caller request key → original prepared build association **before any remote effect**. Store a digest of the immutable request; reject reuse of the same key with different inputs. Use an atomic, single-writer/transactional protocol and recover the crash window between receipt creation and association. No automatic retry may prepare a replacement operation after launch uncertainty.
- Define submit, inspect, reconcile/wait and export boundaries using `BuildHandle`; reuse existing typed errors and completion results. Acknowledged submission must point to durable state, not merely a UUID in transient stdout.
- Specify duplicate requests, concurrent callers, crash recovery, lease deadlines and controller lock behavior. Do not steal stale locks automatically. Model unresolved allocation/admission and do not silently refund it.
- Keep provider credentials on the controller only. Use trusted controller code/config independently of the reviewed app checkout. A TypeScript config/provider module is executable code; untrusted PR code must not run in a credentialed controller process.

Acceptance: retrying an identical external request, including after a lost launch acknowledgement or process restart, preserves one build/remote operation; changed input under the same key is rejected; independent requests do not accidentally alias.

### 2. Continuous reconciliation and completion delivery

- Provide a documented long-lived reconciliation loop or deployment recipe with durable private storage. Async start alone does not retrieve artifacts or retire hosts; observation must resume within the lease/recovery window.
- Persist coherent full receipts, frozen source and provider SQLite state before remote effects and on interruption. An ID, compact result or end-of-job artifact upload cannot reconstruct missing recovery state. Use consistent SQLite backups or closed-adapter snapshots as appropriate.
- Persist terminal publication/delivery intent separately from compilation. Use a small durable outbox/delivery record keyed by build identity, artifact hash and destination; retry failed/uncertain uploads and callbacks without recompiling.
- Define authenticated delivery and destination idempotency. Use bounded retry/backoff and report undelivered terminal outcomes. Do not claim exactly-once external delivery; document duplicate handling.
- Correlate events to source/run/channel and fence stale completions. Preserve terminal state and known compiler failure through delayed progress, disconnects and cleanup retries.

Acceptance: restart between verified retrieval, publication and notification completes delivery using the same artifact/build; observer failure is distinguishable from compiler failure; cleanup uncertainty remains visible even if publication policy permits a usable APK.

### 3. Verified publication and useful CI outputs

- Use `exportArtifact` rather than copying receipt internals. Publish only verified intended artifacts and explicitly reviewed metadata. Keep source archives, journals, receipt paths and raw logs private.
- Define a storage adapter, retention/access policy and availability check. Prefer content-addressed immutable objects with authenticated/private or deliberately approved install links. An expired signed URL must be refreshable without recompiling.
- Expose build ID, tracking/result location, artifact URL/digest/size and work/cleanup outcomes for a GitHub job or notifier. Keep progress detail independent of a specific provider.
- Provide a generic GitHub reusable-workflow/action example only after it is executable against the chosen controller/storage contract. Show source approval, private state restoration, submit/reconnect, reconciliation and completion. Do not present a fragment with undeclared infrastructure as a working first trial.

Acceptance: publishing the same build/hash is idempotent; changed bytes, corrupt artifacts and conflicting destinations fail closed; no public output leaks private receipt/config contents.

### 4. Match the required Android output before adoption

Current qualification covers **debug APKs**. A staging-targeted debug APK that needs Metro is not a standalone internal-distribution preview. A development client also needs its actual dependencies/configuration; do not infer it from an Expo project alone.

- Define explicit supported output intent: ordinary debug APK, Expo development client, and standalone internal preview as separate capabilities. Keep unsupported combinations failing before allocation.
- Implement deterministic task/variant/artifact mapping and Expo embedded JavaScript/assets for standalone preview. Verify application ID, ABIs, runtime/native fingerprint, channel/update configuration and exact output bytes. Discovery/preparation must not execute arbitrary project scripts.
- Keep signing separate from compilation, using controller-side or separately trusted signing with pinned application/certificate identities. Do not transfer release keystores or signing passwords to the VM. Do not assume current debug signing gives standalone release parity.
- Keep production AAB, store submission and iOS on the existing qualified path until separately implemented, authorized and qualified. Preserve Android Builder's independent MIT/provider-neutral scope.

Acceptance: offline validation rejects contradictory configurations; separately authorized real Android builds and device/emulator tests establish the specific output/runtime behavior. Until then documentation says unqualified, and consumer CI is not switched.

### 5. Native compatibility reuse and Expo OTA decision

- Use Expo's native fingerprint tooling/configuration as a compatibility input where applicable. Include native dependency patches, plugin/configuration changes and generated-native policy; do not substitute source commit/full-source hash for native compatibility.
- Design a compatible artifact key covering native fingerprint, application identity, variant/profile, ABI set, relevant toolchain/build configuration and signing identity. Partition access/account/channel policy where required. Keep exact source provenance separate from runtime compatibility.
- Registry entries need a verified artifact, supported runtime metadata, availability/retention checks and authoritative original build identity. Do not reuse failed, corrupt, inaccessible or incompatible artifacts.
- Atomically join a matching in-progress operation. A missing/expired entry must not cause an uncertain original build to be replayed. Define reconciliation and any explicitly authorized replacement policy.
- OTA publishing stays an application/Expo integration step after compatibility validation. Preserve environment/channel correctness, source maps where relevant and stale-preview fences. No OTA to an incompatible binary.

Acceptance: JS-only change chooses a valid OTA path; native/plugin/patch/profile/signing/ABI changes cannot incorrectly reuse an artifact; concurrent compatible requests join safely; expired links can be refreshed; missing artifact bytes are not treated as a reusable success.

### 6. Documentation and fair comparison

Document standard Expo and Android Builder paths side by side, including the infrastructure the user must operate. Explain what remains in Expo and what moves to the controller, where recent runs/install links live, and how retries/recovery work.

Prioritize skip/reuse/OTA preservation before optimization. Use [the benchmark method](benchmarks.md): same immutable app, dependency/configuration, variant, ABI, signing/output/runtime behavior and cache conditions. Report queue, setup, compile, retrieval, cleanup and delivery separately with clear end-to-end boundaries. Measure cold/warm cases separately. Historical generic debug times are not matched EAS preview timings; a cached/OTA run is not a native-build speed comparison. Do not claim faster or cheaper without matching evidence.

## Validation and completion gates

Use focused tests for consequential state transitions: stable request identity under concurrency/restart, uncertain launch, failed compiler plus failed cleanup, corrupt transfer, crash after export/before delivery, duplicate delivery, stale revision/channel events, native compatibility invalidation and unavailable artifacts. Use fixture transports/storage for offline tests; never label these live cloud or real Android qualification.

Run on Linux with Node **24.22.1+**, npm, Git, tar and Python 3 where used by existing tests:

```sh
npm ci --ignore-scripts
npm run check
npm run verify:package
```

Inspect the packed artifact as well as the source: SDK/types/CLI, required host files/docs/examples present, private files/tests/receipts absent. The starting code snapshot passed 35 tests and fresh packed SDK/native/Expo installations; recheck branch CI and rerun after changes. Existing historical hosted results apply to 0.1.0 debug workloads, not newly implemented integration or standalone previews.

Implementation is complete only when a fresh developer can run the documented credential-free trial, integrate the chosen controller contract without provider-journal parsing, recover the same job after restart, and deliver a verified artifact/outcome reliably in the tested scope. Record remaining live qualification and product gaps explicitly. Do not stop after writing another design document.

## Fresh-machine prerequisites and authorization

Implementation, tests, package inspection and generic examples require no `.env`, provider account, signing key or local Android SDK. GitHub authentication is needed only for authorized private reference access or pushing/checking CI. Reinstall dependencies from the lockfile; do not copy `node_modules` or old build output.

A later **separately authorized** hosted test needs controller-only `BOAT_API_KEY`, an existing accepted Android SDK license-hash directory, reviewed immutable inputs, durable private receipt storage and an explicit fresh per-build/total test allowance and lease/cleanup plan. Existing test/account allowances do not transfer. Do not auto-accept license terms. `admitUsd` is an operator admission allowance, not a provider quote or account-wide invoice cap.

Expo calls additionally need an authorized `EXPO_TOKEN` and project/channel configuration. Artifact storage and notifications need only the destination-specific permissions selected during implementation. Signing additionally needs local Android tools, private signing configuration/keystore and pinned application/certificate allowlists. None are prerequisites for starting offline development, and none belong in this repository or on build VMs.

No paid hosts, new public repositories, npm publication, production changes, live signing or consumer-repository changes are authorized by this handoff. A push to this existing handoff branch is authorized; further shipping/adoption should follow the user's current instructions. Keep any local environment-transfer checklist or private consumer reference pack outside tracked/package files.
