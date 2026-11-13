# Build a native Gradle APK

This is a small Java Android app with no JavaScript runtime dependency. Use it to try source preparation and an optional remote debug build without adapting your own app first.

## Set up an isolated app

Use Linux and Node 24.22.1+. First [pack the candidate](../../docs/install.md#pack-this-checkout); the published `0.1.0` does not provide this example's API.

Copy this entire folder into a new directory **outside the Android Builder checkout**, then enter it:

```sh
cp -R /absolute/path/to/android-builder/examples/gradle ./android-hello
cd android-hello
printf 'node_modules/\nbuild-receipt/\n' > .gitignore
```

[Install the tarball in this app](../../docs/install.md#install-in-an-app), then commit the source, package lock and public tarball:

```sh
git init
git add .
git add -f vendor/firtoz-android-builder-0.2.0-dev.0.tgz
git commit -m "Add native Android example"
```

## Prepare without renting a VM

Supply a directory of SDK license hashes you have [already accepted](../../docs/configuration.md#sdk-licenses). No local Java or Android SDK is needed.

```sh
npx android-builder prepare --config android-builder.config.ts \
  --licenses /private/accepted-sdk-licenses --directory ./build-receipt
npx android-builder inspect --directory ./build-receipt
```

Review the report and resolved plan. The application ID, compile SDK and build tools come from frozen native literals; the default task is `:app:assembleDebug` and the conventional APK path is derived. The included `gradlew` verifies a pinned Gradle distribution checksum; it is a small bootstrap rather than a bundled official wrapper.

## Start and retrieve

Provide `BOAT_API_KEY` privately to the controller, then explicitly admit the build:

```sh
npx android-builder start --directory ./build-receipt --admit-usd 0.20
```

A successful build saves the verified `build-receipt/artifact.apk` and retires its owned VM. `$0.20` is an example operator allowance for this build, not a quote, account cap or invoice guarantee; review the selected machine and full lease first.

After an interrupted observation, run `observe --directory ./build-receipt`. If interrupted before launch, explicitly `start` the same receipt. Keep the receipt private and durable; never create another ID to resolve uncertainty. [Recovery](../../docs/operations.md) · [Optional signing/install](../../docs/signing.md).

The current example has offline package/type/preparation checks. Earlier live builds concern `0.1.0`, not this candidate. [Verification status](../../docs/qualification.md).
