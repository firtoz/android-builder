import { defineBuildConfig } from "@firtoz/android-builder";
export default defineBuildConfig({
	project: { kind: "expo" },
	packageManager: { kind: "npm", version: "11.10.1" },
	toolchain: { ndk: "27.1.12297006", cmake: "3.22.1" },
	artifact: "android/app/build/outputs/apk/debug/app-debug.apk",
	applicationId: "org.example.builderhello",
	reservationUsd: 0.2,
});
