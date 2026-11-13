# Small monorepo recipe

Use one Git root, one root install/lockfile, one Expo project and source-oriented local packages:

```text
package.json               # packageManager: "bun@1.4.4", workspaces: ["apps/*", "packages/*"]
bun.lock
apps/mobile/package.json   # expo plus "shared": "file:../../packages/shared"
apps/mobile/app.json       # expo.android.package
apps/mobile/App.tsx
packages/shared/package.json   # name: "shared", main: "index.js"
packages/shared/index.js
android-builder.config.ts
```

```ts
import { defineProjectConfig } from '@firtoz/android-builder';
export default defineProjectConfig({
  project: { kind: 'expo', directory: 'apps/mobile' },
  toolchain: { ndk: '27.1.12297006', cmake: '3.22.1' },
  source: { requiredFiles: ['packages/shared/index.js'] },
  admissionAllowanceUsd: 0.20,
});
```

Commit the manifest, root lockfile and all intended source. Run the normal README prepare/inspect/start commands from the Git root. The root package manager/lock supplies installation; the app's app.json supplies its static expected ID; the APK path is prefixed with `apps/mobile/android/`. `file:../../packages/shared` resolves from `apps/mobile/package.json`, **not** the repository root. Omitting the shared manifest or its literal entrypoint fails preflight even when it still exists on disk. A public dependency archive can be included with an exact `source.extraFiles` path.

npm can use the same simple workspace layout with a root npm pin and package-lock, and npm-compatible local/version dependencies. Bun also supports named `workspace:` dependencies checked against frozen workspace names. Yarn, pnpm workspaces, recursive/negative globs and independent per-project root installs are not supported. A native Gradle project inside a monorepo points `project.directory` at its checked-in `gradlew`; JavaScript dependencies, when configured, still install at the Git root. [Precise source/dependency limits](configuration.md).

Review required dynamic/generated inputs and final build settings before starting. [Supported outcomes and verification status](qualification.md).
