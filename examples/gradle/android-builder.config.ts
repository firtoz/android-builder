import { defineBuildConfig } from "@firtoz/android-builder";
export default defineBuildConfig({
	project: { kind: "gradle" },
	artifact: "app/build/outputs/apk/debug/app-debug.apk",
	applicationId: "org.example.hello",
	reservationUsd: 0.2,
});
