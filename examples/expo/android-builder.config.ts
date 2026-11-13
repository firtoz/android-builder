import { defineProjectConfig } from "@firtoz/android-builder";
export default defineProjectConfig({
	project: { kind: "expo" },
	// Generated native tool requirements cannot be read from app.json.
	toolchain: { ndk: "27.1.12297006", cmake: "3.22.1" },
	admissionAllowanceUsd: 0.2,
});
