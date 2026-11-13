# Install the candidate

These guides use `0.2.0-dev.0`, which is not published. Installing the current npm release `0.1.0` will not provide `defineProjectConfig`, `createBuilder` or the new CLI commands. Existing users can follow the [migration guide](migration.md).

Use Linux with Node 24.22.1+, Git and tar. No Android tools or cloud credentials are needed for these steps.

## Pack this checkout

From the Android Builder source checkout:

```sh
npm ci --ignore-scripts
npm pack
```

The package's prepack step builds its runtime and types. Keep the absolute paths to the checkout and generated `firtoz-android-builder-0.2.0-dev.0.tgz`; the example guides use them to copy a complete app and install the package.

## Install in an app

From your app directory, put the public tarball inside the repository before installing it:

```sh
mkdir -p vendor
cp /absolute/path/to/firtoz-android-builder-0.2.0-dev.0.tgz vendor/
npm install --ignore-scripts --save-dev ./vendor/firtoz-android-builder-0.2.0-dev.0.tgz
npx android-builder --help
```

Commit the updated manifest/lockfile and the tarball. If your Git ignore rules exclude archives, explicitly add this reviewed public file with `git add -f vendor/firtoz-android-builder-0.2.0-dev.0.tgz`. A local `file:` dependency outside the frozen source fails preparation, including dev dependencies. [Source-selection rules](configuration.md#source-boundary).

Continue with the [native app](../examples/gradle/README.md) or [Expo app](../examples/expo/README.md), or configure your existing project using the [configuration reference](configuration.md).

## Use a separate controller

CI and other integrations can install the package outside the app and pass `--root /path/to/app` with a trusted JSON configuration. JSON avoids importing a TypeScript module from the app or requiring it to resolve the controller package. This keeps controller dependencies separate from app inputs. [CI recipe](ci.md).

This installation does not authorize a cloud build. `prepare` and `inspect` are offline; `start --admit-usd` is the separate spending decision. SDK terms are never accepted automatically, and signing remains optional and separate.
