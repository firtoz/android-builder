# Build an Expo debug APK

This is a minimal Expo app. Prebuild generates its Android project; the result is a debug APK for the usual Metro/development workflow, not a self-contained production JS bundle or a qualified development-client build.

## Set up an isolated app

Use Linux and Node 24.22.1+. First [pack the candidate](../../docs/install.md#pack-this-checkout); the published `0.1.0` does not provide this example's API.

Copy this entire folder into a new directory **outside the Android Builder checkout**, then enter it:

```sh
cp -R /absolute/path/to/android-builder/examples/expo ./expo-hello
cd expo-hello
printf 'node_modules/\nbuild-receipt/\n' > .gitignore
```

[Install the tarball in this app](../../docs/install.md#install-in-an-app). That installation resolves the app dependencies and writes its lockfile. Commit the source, lockfile and public tarball:

```sh
git init
git add .
git add -f vendor/firtoz-android-builder-0.2.0-dev.0.tgz
git commit -m "Add Expo Android example"
```

## Prepare without renting a VM

Supply a directory of SDK license hashes you have [already accepted](../../docs/configuration.md#sdk-licenses). No local Android toolchain is needed.

```sh
npx android-builder prepare --config android-builder.config.ts \
  --licenses /private/accepted-sdk-licenses --directory ./build-receipt
npx android-builder inspect --directory ./build-receipt
```

Review the report and resolved plan. Root `package.json#packageManager` supplies npm, `app.json` supplies the expected application ID, and the debug APK path is derived. NDK/CMake remain explicit because generated native requirements cannot be safely inferred from app.json. Keep this source free of an `android/` tree; an existing native project uses the Gradle profile instead.

For a side-by-side EAS comparison, async start/reconnect and optional development-client/Orbit handoff, see [Expo workflow](../../docs/expo.md). This minimal example remains a plain debug app; it does not include expo-dev-client.

## Start and retrieve

Provide `BOAT_API_KEY` privately to the controller, then explicitly admit the build:

```sh
npx android-builder start --directory ./build-receipt --admit-usd 0.20
```

A successful build saves the verified `build-receipt/artifact.apk` and retires its owned VM. `$0.20` is an example operator allowance for this build, not a quote, account cap or invoice guarantee; review the selected machine and full lease first.

After an interrupted observation, run `observe --directory ./build-receipt`. If interrupted before launch, explicitly `start` the same receipt. Keep the receipt private and durable; never create another ID to resolve uncertainty. [Recovery](../../docs/operations.md) · [Optional signing/install](../../docs/signing.md).

The current example has offline package/type/preparation checks. Earlier live builds concern `0.1.0`, not this candidate. [Verification status](../../docs/qualification.md).
