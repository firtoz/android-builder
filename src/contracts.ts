import { createHash } from "node:crypto";
import { z } from "zod";

export const ANDROID_BUILD = {
	uploadBytes: 4 * 1024 * 1024,
	maxSourceBytes: 64 * 1024 * 1024,
	maxArtifactBytes: 1024 * 1024 * 1024,
	maxLogBytes: 32 * 1024 * 1024,
	pollMs: 5_000,
} as const;
export const sha256 = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const relativePath = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(s) =>
			!s.startsWith("/") &&
			!s.includes("\\") &&
			s
				.split("/")
				.every((p) => p !== ".." && p !== "" && (p !== "." || s === ".")),
		"Expected a relative path without traversal",
	);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const environment = z
	.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(8192))
	.refine(
		(values) =>
			Object.keys(values).every(
				(key) =>
					!/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL)/.test(key),
			),
		"Build environment is public; credentials belong on the controller",
	);
export const buildConfig = z
	.strictObject({
		project: z.discriminatedUnion("kind", [
			z.strictObject({
				kind: z.literal("expo"),
				directory: relativePath.default("."),
				prebuild: z.boolean().default(true),
			}),
			z.strictObject({
				kind: z.literal("gradle"),
				directory: relativePath.default("."),
			}),
		]),
		packageManager: z
			.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("npm"), version: version }),
				z.strictObject({ kind: z.literal("bun"), version: version }),
				z.strictObject({ kind: z.literal("pnpm"), version: version }),
			])
			.optional(),
		toolchain: z
			.strictObject({
				node: version.default("24.22.1"),
				javaMajor: z.number().int().min(17).max(25).default(17),
				sdk: z.number().int().positive().default(36),
				buildTools: version.default("36.0.0"),
				ndk: version.optional(),
				cmake: version.optional(),
				toolsArchive: z
					.string()
					.regex(/^commandlinetools-linux-[0-9]+_latest\.zip$/)
					.default("commandlinetools-linux-15859902_latest.zip"),
				toolsSha256: digest.default(
					"4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
				),
			})
			.default({
				node: "24.22.1",
				javaMajor: 17,
				sdk: 36,
				buildTools: "36.0.0",
				toolsArchive: "commandlinetools-linux-15859902_latest.zip",
				toolsSha256:
					"4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
			}),
		gradle: z
			.strictObject({
				tasks: z
					.array(z.string().regex(/^:?[a-zA-Z0-9_:-]+$/))
					.min(1)
					.max(16)
					.default([":app:assembleDebug"]),
				arguments: z
					.array(z.string().max(512))
					.max(32)
					.default([
						"--console=plain",
						"--no-daemon",
						"--max-workers=2",
						"-Pkotlin.compiler.execution.strategy=in-process",
					]),
				heapMb: z.number().int().min(512).max(16384).default(3072),
			})
			.default({
				tasks: [":app:assembleDebug"],
				arguments: [
					"--console=plain",
					"--no-daemon",
					"--max-workers=2",
					"-Pkotlin.compiler.execution.strategy=in-process",
				],
				heapMb: 3072,
			}),
		artifact: relativePath,
		applicationId: z
			.string()
			.regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
		abis: z
			.array(z.enum(["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]))
			.min(1)
			.max(4)
			.optional(),
		publicEnvironment: environment.default({}),
		publicInputs: z
			.array(
				z.strictObject({ source: z.string().min(1), target: relativePath }),
			)
			.max(16)
			.default([]),
		source: z
			.strictObject({
				extraFiles: z.array(relativePath).max(128).default([]),
				requiredFiles: z.array(relativePath).max(128).default([]),
			})
			.default({ extraFiles: [], requiredFiles: [] }),
		lifetimeSeconds: z.number().int().min(300).max(3600).default(3600),
		executionSeconds: z.number().int().min(30).max(3300).default(3000),
		reservationUsd: z.number().positive().max(100),
	})
	.superRefine((value, ctx) => {
		if (value.executionSeconds > value.lifetimeSeconds - 60)
			ctx.addIssue({
				code: "custom",
				path: ["executionSeconds"],
				message: "Execution must end at least 60 seconds before the lease",
			});
		if (value.project.kind === "expo" && !value.packageManager)
			ctx.addIssue({
				code: "custom",
				path: ["packageManager"],
				message: "Expo requires a package manager",
			});
		if (value.project.kind === "expo" && value.project.prebuild === false)
			ctx.addIssue({
				code: "custom",
				path: ["project"],
				message: "Use the Gradle profile for an existing native project",
			});
	});
export type BuildConfig = z.infer<typeof buildConfig>;
export type BuildConfigInput = z.input<typeof buildConfig>;
export function defineBuildConfig(config: BuildConfigInput): BuildConfig {
	return buildConfig.parse(config);
}
export const inputFile = z.strictObject({
	name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
	bytes: z.number().int().positive().max(ANDROID_BUILD.maxSourceBytes),
	sha256: digest,
});
export const remoteStatus = z.object({
	state: z.enum(["running", "complete", "failed"]),
	phase: z.string().max(512),
	logTruncated: z.boolean().default(false),
	exitCode: z.number().int().optional(),
	artifact: z
		.object({
			bytes: z.number().int().positive().max(ANDROID_BUILD.maxArtifactBytes),
			sha256: digest,
		})
		.optional(),
	timings: z
		.array(
			z.object({
				phase: z.string().max(512),
				seconds: z.number().nonnegative(),
				exitCode: z.number().int(),
			}),
		)
		.max(64)
		.default([]),
});
export const buildJournal = z.strictObject({
	version: z.literal(1),
	id: z.uuid(),
	owner: z.uuid(),
	preparedAt: z.number().int(),
	sourceHash: digest,
	sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
	workingTree: z.boolean(),
	config: buildConfig,
	inputs: z.array(inputFile).min(1).max(32),
	state: z.enum([
		"prepared",
		"allocating",
		"allocated",
		"uploaded",
		"launching",
		"running",
		"complete",
		"failed",
	]),
	expiresAt: z.number().int().optional(),
	hostId: z.string().min(1).max(200).optional(),
	logCursor: z.number().int().min(0).max(ANDROID_BUILD.maxLogBytes).default(0),
	outcome: remoteStatus.optional(),
	artifactVerified: z.boolean().default(false),
	retired: z.boolean().default(false),
	hostAbsent: z.boolean().default(false),
	admission: z
		.object({
			allowanceUsd: z.number().positive(),
			operatorLimitUsd: z.number().positive(),
			admittedAt: z.number().int(),
		})
		.optional(),
	cleanupError: z.boolean().default(false),
});
export type BuildJournal = z.infer<typeof buildJournal>;
/** Adapters must durably fence allocate and verify ownership before retirement. */
export interface BuilderTransport {
	allocate(input: {
		owner: string;
		operationId: string;
		expiresAt: number;
	}): Promise<string>;
	ready(host: string): Promise<void>;
	command(host: string, command: string): Promise<string>;
	upload(host: string, path: string, bytes: Uint8Array): Promise<void>;
	download(
		host: string,
		path: string,
		bytes: number,
		target: string,
		expectedHash: string,
	): Promise<void>;
	retire(host: string, operationId: string): Promise<void>;
}
export function spendingLimit(
	value: number | string | undefined,
	reservationUsd: number,
) {
	const limit = Number(value);
	if (!Number.isFinite(limit) || limit < reservationUsd || limit > 100)
		throw Error(
			`Explicit per-build limit must cover the $${reservationUsd} reservation (maximum $100). This is not an aggregate allowance or invoice.`,
		);
	return limit;
}
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
