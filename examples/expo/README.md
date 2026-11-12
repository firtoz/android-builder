# Expo hello

A minimal Expo application; prebuild creates its Android project. No account identifiers, Firebase or model services are required. This is a candidate pending a real hosted Android build.

1. Copy this whole folder into a new Git repository and commit its source. Use Node24.22.1+.
2. Install the local packed Android Builder tarball with `npm install --save-dev /path/to/package.tgz` (after publication, `npm install --save-dev @firtoz/android-builder`). Commit the updated manifest and lockfile.
3. Supply an existing accepted Android SDK licenses directory; no terms are accepted automatically.
4. Run:

```sh
npx android-builder prepare --config android-builder.config.ts --licenses /path/to/sdk/licenses --directory ./build-receipt
# Review the frozen source-manifest.json. Supply BOAT_API_KEY privately on the controller.
npx android-builder run --directory ./build-receipt --max-usd 0.20
```

The application ID, source profile, artifact and operator reservation are explicit in `android-builder.config.ts`. $0.20 is an example per-build reservation, not a provider quote or aggregate budget. Increase it if your selected host/fees require more. Reconnect with the same receipt directory after a disconnect. Signing and device installation remain separate explicit steps.
