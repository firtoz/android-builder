# Signing stays separate

Build hosts receive source and explicitly public build inputs. Provider credentials and release keystores stay on the controller or a separate trusted signing job. Build artifacts may use the project's generated debug identity; this does not establish store-release readiness.

After a successful verified build, set `ANDROID_HOME` to an existing local SDK, `ANDROID_SIGNER_SHA256` to the expected certificate digest and `ANDROID_SIGNING_CONFIG` to a private JSON file:

```json
{
  "keystorePath": "./private.keystore",
  "keystorePassword": "PRIVATE",
  "keyAlias": "android",
  "keyPassword": "PRIVATE",
  "applications": ["org.example.hello"]
}
```

Protect that file and keystore from other users. Passwords pass to apksigner in a narrowly constructed subprocess environment, not command arguments or remote build inputs. Signing checks the exact verified artifact hash, application allowlist and resulting certificate before publishing `app-signed.apk`. On failure it retains the unsigned artifact and removes the partial signed output.

```sh
npx android-builder sign --directory ./build-receipt
# Optional; requires an existing ADB device selected explicitly, never starts one:
npx android-builder install --directory ./build-receipt --serial emulator-5554
```

No signing key is generated or uploaded by this package. Local SDK/signing/ADB are needed only for these explicit commands; building does not install them on the controller. Store submission, release AAB and iOS are not qualified.
