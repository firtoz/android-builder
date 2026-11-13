# Use Android Builder with Expo

Keep Expo for app configuration, prebuild, Metro and development tooling; use Android Builder to compile the Android native app on a dedicated VM. You do not need to send compilation through EAS Build. Android Builder still runs Expo **prebuild**, then Gradle—it does not replace Expo's native project generation.

These commands require the [unpublished candidate](install.md), a supported [Expo configuration](../examples/expo/android-builder.config.ts), committed source/lockfile and already accepted SDK license hashes. The [complete Expo example](../examples/expo/README.md) covers setup.

## Compare the workflows

### Expo's managed build workflow

For an Expo project configured with EAS and a development profile:

```sh
eas build --platform android --profile development --no-wait
eas build:list --platform android
# Retrieve/install the completed development build, then on your development machine:
npx expo start --dev-client
```

EAS tracks hosted builds in the Expo dashboard. Its asynchronous mode is already supported; asynchronous building is not unique to Android Builder. EAS also provides managed signing, iOS builds, caching and development-build reuse. [EAS CLI reference](https://docs.expo.dev/eas/cli/) · [Expo Build features](https://docs.expo.dev/build/introduction/).

### Android Builder's workflow

```sh
npx android-builder prepare --config android-builder.config.ts \
  --licenses /private/accepted-sdk-licenses --directory ./.android-builds/first
npx android-builder inspect --directory ./.android-builds/first
# Explicit per-build admission, with BOAT_API_KEY only on the controller:
npx android-builder start --directory ./.android-builds/first --admit-usd 0.20 --no-wait
npx android-builder list
# Later, or in a durable CI observer:
npx android-builder observe --directory ./.android-builds/first
```

`start --no-wait` returns after acknowledged launch, not after compilation. It releases the local controller/adapter and leaves the bounded remote job running. It does not spawn a background daemon. Observe the **same receipt before lease expiry** to retrieve/verify the APK and finish cleanup. If no observer runs, no local artifact is downloaded or completion handoff performed, and the remote artifact can be lost at lease expiry. Lost launch acknowledgement remains an error; only observation may resolve it, never another launch.

`list` is a recent-build view of private local receipts, not a remote refresh. It shows separate work/cleanup state and recorded artifact verification, newest first. The default parent is `.android-builds`; choose another with `--receipts-directory PATH`. Custom receipt directories are listed by their direct parent. Listing does not require the provider module/credentials, rehash APKs or steal locks. Unreadable/incomplete journals appear as issues; preserve them for investigation. [Recovery and errors](operations.md).

## Finish in Expo's development tools

For your own app, add `expo-dev-client` using `npx expo install expo-dev-client` **before freezing source**, then commit the changed manifest/lockfile and required public configuration. Use versions compatible with that app's Expo SDK. The minimal example does not currently include this library and is not a qualified development-client build. Installing a package alone is not evidence of a tested device launch.

After `observe` retrieves the APK:

1. Choose the verified local APK. The SDK's `artifact()` rechecks its current bytes. Follow your signing policy; the package's [local signing/install path](signing.md) verifies the allowed application and pinned signing certificate separately.
2. Optionally open the selected APK in **Expo Orbit**. Expo documents installation from local Android APK files. Orbit is a separate, user-controlled installer; this package does not install Orbit, select/start a device or run it automatically. Orbit's own installation path is separate from Android Builder's signed-install checks. [Orbit local files](https://docs.expo.dev/build/orbit/).
3. On your development machine, run `npx expo start --dev-client` and connect the installed development build through its usual launcher/URL. Metro runs on that machine, not on the disposable build VM. JavaScript-only changes can use Metro/Fast Refresh without another native compile; native dependency/configuration changes require a new native build. [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/).

A CI controller can keep `observe` running, persist its result and export the verified artifact when ready. An exit caused by unconfirmed retirement can still have a usable artifact; report the cleanup failure separately. Do not put Expo/provider/signing tokens into the frozen source or build environment, or trigger another compile to retry an export/handoff.

## Track the job in Expo's dashboard

For Expo-visible status while Android Builder does the native compile, use an **Expo Workflows custom job as the controller**, then attach the verified APK to that workflow run. This is a documented integration seam: custom jobs accept shell steps, and `eas/upload_artifact` with `type: other` attaches a generic artifact to the run. Build-specific artifact types are reserved for EAS build jobs. [Workflow syntax and artifacts](https://docs.expo.dev/eas/workflows/syntax/#easupload_artifact).

Flow: **Expo workflow/controller → Android Builder VM → verified APK → workflow artifact → optional Orbit/Metro**. The dashboard shows a recent **workflow run** with status/logs/artifact, not a native `eas build:list` record. The controller still runs on Expo infrastructure and can consume workflow resources; this is not an assertion that all work/cost has left Expo.

Once an operator has configured that workflow, use `eas workflow:runs` for its recent runs and `eas workflow:status WORKFLOW_RUN_ID --wait` to follow one run. These are workflow commands, not native build-history commands. [EAS CLI workflow commands](https://docs.expo.dev/eas/cli/).

The following is an integration fragment, not a self-provisioning workflow. Before it runs, a trusted job must supply Node 24.22.1+/Git/tar, a pinned installed candidate controller (`ANDROID_BUILDER_BIN`), provider credentials, and the complete private receipt (`ANDROID_BUILDER_RECEIPT`) restored from durable storage. That receipt belongs to an already explicitly admitted/launched build, potentially started in another process with `--no-wait`. Configure private state backup/restore on interruption before adopting this pattern; an Expo worker's ephemeral filesystem is not durable receipt storage. The [CI guide](ci.md) covers those responsibilities.

```yaml
jobs:
  android_builder:
    name: Retrieve Android Builder APK
    environment: development
    steps:
      - name: Observe the existing admitted build
        run: |
          set -eu
          : "${ANDROID_BUILDER_BIN:?Supply the reviewed controller executable}"
          : "${ANDROID_BUILDER_RECEIPT:?Restore the original private receipt}"
          "$ANDROID_BUILDER_BIN" wait --directory "$ANDROID_BUILDER_RECEIPT" --json \
            > "$ANDROID_BUILDER_RECEIPT/expo-workflow-result.json" \
            2> "$ANDROID_BUILDER_RECEIPT/expo-workflow-output.log"
          "$ANDROID_BUILDER_BIN" export --directory "$ANDROID_BUILDER_RECEIPT" \
            --output approved-output/artifact.apk --json \
            > "$ANDROID_BUILDER_RECEIPT/expo-workflow-export.json"
      - uses: eas/upload_artifact
        with:
          type: other
          name: android-debug-apk
          path: approved-output/artifact.apk
```

`wait` provides a compact typed completion and exits successfully only after complete verified work and confirmed cleanup. `export` atomically produces the upload file and safely accepts an identical destination on retry. [Automation API](automation.md). Only the explicitly selected APK is uploaded as a workflow artifact. Raw result/observed output are redirected into the private receipt instead of the workflow log; keep those files, source archives and provider state in approved durable private storage. Restrict Expo artifact access too. Apply your signing and artifact-sharing policy before enabling the upload. This conservative fragment uploads only after observation/retrieval/cleanup all succeed. A compiler failure, corrupt transfer or unconfirmed retirement fails the step; preserve the original private receipt and report cleanup independently. Retry observation/cleanup or artifact export using the existing identity, never another compile to recover an upload.

This fragment has been checked against the published workflow contract, but has **not** been executed on Expo or qualified with a real Android build. No credentials, account registration or live workflow are created here. A full one-command setup for Expo controller dependencies/state storage remains future integration work.

## Will it appear in recent builds on expo.dev?

**Not automatically.** An Expo app/project association, opening a local APK in Orbit, and an EAS build-history record are different operations. `eas build:list` lists EAS builds; it does not read Android Builder receipts.

As of November 13, 2026, the public [EAS CLI reference](https://docs.expo.dev/eas/cli/) does not document an external-APK build-history import command. This is a limit of the integration confirmed here, not a claim that no private or future Expo API could exist. `eas submit --path` submits a binary to a store; it is not a substitute for importing an external build into the dashboard. No undocumented GraphQL integration, placeholder EAS build ID or automatic account upload is implemented.

Use EAS Build when native EAS build records and managed build/distribution are the priority. Use Android Builder when you want compute/admission control, private recoverable receipts and separate signing; the optional custom-workflow pattern can retain Expo-visible job tracking without pretending the result is an EAS build record. A native build-history import would still need a documented Expo interface and an independent receipt/retry contract.

## Speed expectations

Our historical minimal Expo debug build took **4 min 46 s** from allocation through verified download and confirmed retirement, including cold tool installation. Its Gradle phase took about **3 min 14 s**. Those are `0.1.0` observations, not a development-client, current-candidate or matched EAS benchmark. There is no measured EAS comparison yet, so no relative speed/cost claim is justified. [Recorded measurements](../maintainer/qualification.md) · [Matched-comparison method](../maintainer/benchmarks.md).
