import { posix } from "node:path";
import { z } from "zod";
import {
	type BuildConfig,
	type BuildConfigInput,
	buildConfig,
} from "./contracts.js";

const manifestSchema = z.looseObject({
	name: z.string().optional(),
	packageManager: z.string().optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
	optionalDependencies: z.record(z.string(), z.string()).optional(),
	workspaces: z.unknown().optional(),
	patchedDependencies: z.record(z.string(), z.string()).optional(),
	pnpm: z
		.object({
			patchedDependencies: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
	expo: z
		.object({
			android: z.object({ package: z.string().optional() }).optional(),
		})
		.optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

// Strip comments while preserving quoted strings; never evaluate Gradle code.
function gradleText(text: string): string {
	return text.replace(
		/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
		(match, quoted: string | undefined) =>
			quoted ?? match.replace(/[^\n]/g, " "),
	);
}
/** Project intent; resolution uses frozen files, never executes project code. */
export type ProjectConfigInput = Omit<
	BuildConfigInput,
	"artifact" | "applicationId" | "reservationUsd"
> & {
	artifact?: string;
	applicationId?: string;
	admissionAllowanceUsd: number;
};
const preparationShape = z.strictObject({
	...buildConfig.shape,
	artifact: buildConfig.shape.artifact.optional(),
	applicationId: buildConfig.shape.applicationId.optional(),
	reservationUsd: buildConfig.shape.reservationUsd.optional(),
	admissionAllowanceUsd: buildConfig.shape.reservationUsd.optional(),
});
export function validatePreparationInput(input: unknown): void {
	preparationShape.parse(input);
}
export function defineProjectConfig(
	config: ProjectConfigInput,
): ProjectConfigInput {
	validatePreparationInput(config);
	return config;
}
export type PreparationConfig = BuildConfigInput | ProjectConfigInput;
export interface PreparationReport {
	version: 1;
	id: string;
	directory: string;
	repositoryRoot: string;
	projectDirectory: string;
	sourceCommit: string;
	workingTree: boolean;
	sourceDescription: string;
	included: string[];
	excluded: { path: string; reason: string }[];
	relevantInputs: string[];
	localDependencies: { manifest: string; specifier: string; target: string }[];
	errors: string[];
	warnings: string[];
	resolved?: BuildConfig;
	provenance: Record<string, string>;
	limits: string[];
}
export const reportLimits = [
	"Checks frozen files and statically declared inputs only; not a secret scanner or a complete dependency resolver.",
	"Project scripts, dynamic Expo/Gradle configuration and network dependencies are not evaluated during preparation.",
	"npm/Bun root workspaces support literal directories and one trailing /*; pnpm workspace layouts and Yarn are rejected.",
];
export function resolveConfiguration(
	input: PreparationConfig,
	files: Map<string, string>,
	report: PreparationReport,
): BuildConfig | undefined {
	const raw = { ...input } as Record<string, unknown>;
	const project = input.project;
	const dir = project.directory ?? ".";
	const at = (path: string) => posix.join(dir, path);
	const nativeFiles = new Map(
		[...files]
			.filter(([p]) => /(?:^|\/)build\.gradle(?:\.kts)?$/.test(p))
			.map(([p, text]) => [p, gradleText(text)]),
	);
	const parse = (path: string): Manifest | undefined => {
		const bytes = files.get(path);
		if (bytes === undefined) return;
		try {
			const v = manifestSchema.parse(JSON.parse(bytes));
			if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
			return v;
		} catch {
			report.errors.push(`Invalid JSON in frozen ${path}`);
			return;
		}
	};
	const infer = (key: string, value: unknown, source: string) => {
		if (raw[key] === undefined && value !== undefined) {
			raw[key] = value;
			report.provenance[key] = source;
		} else if (raw[key] !== undefined)
			report.provenance[key] = "explicit configuration";
	};
	if ("admissionAllowanceUsd" in raw) {
		if (
			raw.reservationUsd !== undefined &&
			raw.reservationUsd !== raw.admissionAllowanceUsd
		)
			report.errors.push(
				"admissionAllowanceUsd conflicts with legacy reservationUsd",
			);
		raw.reservationUsd = raw.admissionAllowanceUsd;
		delete raw.admissionAllowanceUsd;
	}
	const rootPackage = parse("package.json");
	const pkg = parse(at("package.json"));
	const pm = rootPackage?.packageManager;
	if (pkg?.packageManager && pm && pkg.packageManager !== pm)
		report.errors.push(
			"Project packageManager conflicts with root installation packageManager",
		);
	if (typeof pm === "string") {
		const match = /^(npm|bun|pnpm)@(\d+\.\d+\.\d+)$/.exec(pm);
		if (!match)
			report.errors.push(
				"Root packageManager must pin a supported npm, bun or pnpm version",
			);
		else if (
			input.packageManager &&
			`${input.packageManager.kind}@${input.packageManager.version}` !== pm
		)
			report.errors.push(
				"Explicit packageManager conflicts with frozen package.json#packageManager",
			);
		else
			infer(
				"packageManager",
				{ kind: match[1], version: match[2] },
				"package.json#packageManager",
			);
	}
	if (project.kind === "expo") {
		const app = parse(at("app.json"));
		const appId = app?.expo?.android?.package;
		if (
			!files.has(at("app.json")) &&
			!files.has(at("app.config.ts")) &&
			!files.has(at("app.config.js"))
		)
			report.errors.push(
				"Expo requires a frozen app.json or app.config.ts/js; implicit generated configuration is unsupported",
			);
		if (
			typeof appId === "string" &&
			input.applicationId &&
			appId !== input.applicationId
		)
			report.errors.push(
				"applicationId conflicts with frozen app.json#expo.android.package",
			);
		infer("applicationId", appId, `${at("app.json")}#expo.android.package`);
		if (!pkg?.dependencies?.expo && !pkg?.devDependencies?.expo)
			report.errors.push(
				`Expo project requires expo in frozen ${at("package.json")}`,
			);
		if ([...files.keys()].some((p) => p.startsWith(`${at("android")}/`)))
			report.errors.push(
				"Expo prebuild requires no frozen android/ tree; use the Gradle profile for existing native sources",
			);
		if (files.has(at("app.config.ts")) || files.has(at("app.config.js"))) {
			if (!input.applicationId)
				report.errors.push(
					"Dynamic Expo configuration requires explicit applicationId",
				);
			report.warnings.push(
				"Dynamic Expo config is not evaluated; explicit public environment and toolchain may be required",
			);
		}
	} else {
		const paths = [at("app/build.gradle"), at("app/build.gradle.kts")];
		const matches = paths.flatMap((p) =>
			[
				...(nativeFiles.get(p) ?? "").matchAll(
					/(?:^|[;{}\n])\s*applicationId\s*(?:=\s*)?["']([A-Za-z][A-Za-z0-9_.]+)["'](?=\s*(?:[;\r\n}]|$))/g,
				),
			].map((m) => ({ value: m[1], path: p })),
		);
		const variableId = paths.some((p) =>
			/\b(applicationIdSuffix|productFlavors)\b/.test(nativeFiles.get(p) ?? ""),
		);
		const assignmentCount = paths.reduce(
			(n, p) =>
				n +
				[...(nativeFiles.get(p) ?? "").matchAll(/\bapplicationId\b/g)].length,
			0,
		);
		if (matches.length === 1 && assignmentCount === 1 && !variableId) {
			if (input.applicationId && input.applicationId !== matches[0]?.value)
				report.errors.push(
					"applicationId conflicts with the literal native applicationId",
				);
			infer(
				"applicationId",
				matches[0]?.value,
				`${matches[0]?.path} literal applicationId`,
			);
		} else if (!input.applicationId)
			report.errors.push(
				"Native applicationId is not unambiguous; supply it explicitly",
			);
		if (variableId && !input.applicationId)
			report.errors.push(
				"Native flavors/applicationIdSuffix require an explicit final applicationId",
			);
	}
	const tasks = input.gradle?.tasks ?? [":app:assembleDebug"];
	if (tasks.some((t) => /bundle|release/i.test(t)))
		report.errors.push(
			"Only debug APK assembly is supported; release/AAB tasks are not qualified",
		);
	if (
		!input.artifact &&
		(tasks.length !== 1 ||
			![":app:assembleDebug", "app:assembleDebug"].includes(tasks[0] ?? ""))
	)
		report.errors.push("Custom tasks require an explicit artifact path");
	infer(
		"artifact",
		at(
			`${project.kind === "expo" ? "android/" : ""}app/build/outputs/apk/debug/app-debug.apk`,
		),
		"conventional :app:assembleDebug single APK path",
	);
	if (
		typeof raw.artifact === "string" &&
		(!raw.artifact.endsWith(".apk") || /\/release\//.test(raw.artifact))
	)
		report.errors.push(
			"artifact must select a debug .apk, not a release or AAB output",
		);
	if (
		typeof raw.artifact === "string" &&
		tasks.every((t) => /assembleDebug$/.test(t)) &&
		/\/outputs\/apk\/(?!debug\/)/.test(raw.artifact)
	)
		report.errors.push(
			"assembleDebug contradicts the selected artifact variant directory",
		);
	if (typeof raw.artifact === "string" && tasks.length === 1) {
		const task = /^:?(.*):assemble([A-Z][A-Za-z0-9]*)$/.exec(tasks[0] ?? "");
		const output = /^(.*)\/build\/outputs\/apk\/(.+)\/[^/]+\.apk$/.exec(
			raw.artifact,
		);
		if (task && output) {
			const module = at(
				`${project.kind === "expo" ? "android/" : ""}${task[1]?.replaceAll(":", "/")}`,
			);
			if (
				output[1] !== module ||
				output[2]?.replaceAll("/", "").toLowerCase() !== task[2]?.toLowerCase()
			)
				report.errors.push(
					"Gradle task module/variant contradicts the conventional APK output path",
				);
		}
	}
	if (input.abis)
		for (const arg of input.gradle?.arguments ?? []) {
			if (
				arg.startsWith("-PreactNativeArchitectures=") &&
				arg
					.slice("-PreactNativeArchitectures=".length)
					.split(",")
					.sort()
					.join(",") !== [...input.abis].sort().join(",")
			)
				report.errors.push(
					"ABI selection conflicts with gradle.arguments reactNativeArchitectures",
				);
		}
	if (project.kind === "gradle") {
		const toolchain = { ...input.toolchain };
		for (const [key, expression] of [
			[
				"sdk",
				/(?:^|[;{}\n])\s*compileSdk(?:Version)?\s*(?:=\s*)?(\d+)(?=\s*(?:[;\r\n}]|$))/g,
			],
			[
				"buildTools",
				/(?:^|[;{}\n])\s*buildToolsVersion\s*(?:=\s*)?["'](\d+\.\d+\.\d+)["'](?=\s*(?:[;\r\n}]|$))/g,
			],
			[
				"ndk",
				/(?:^|[;{}\n])\s*ndkVersion\s*(?:=\s*)?["'](\d+\.\d+\.\d+)["'](?=\s*(?:[;\r\n}]|$))/g,
			],
		] as const) {
			const candidates = [...nativeFiles]
				.filter(
					([p]) =>
						p.startsWith(dir === "." ? "" : `${dir}/`) &&
						/(?:^|\/)build\.gradle(?:\.kts)?$/.test(p),
				)
				.flatMap(([p, text]) =>
					[...text.matchAll(expression)].map((m) => ({
						path: p,
						value: key === "sdk" ? Number(m[1]) : m[1],
					})),
				);
			const values = new Set(candidates.map((v) => v.value));
			if (values.size > 1) {
				if (toolchain[key] === undefined)
					report.errors.push(
						`Conflicting native ${key} literals; supply an explicit toolchain override`,
					);
				continue;
			}
			if (values.size === 1) {
				const value = candidates[0]?.value;
				if (toolchain[key] === undefined) {
					Object.assign(toolchain, { [key]: value });
					report.provenance[`toolchain.${key}`] =
						`${candidates[0]?.path} literal ${key}`;
				} else if (toolchain[key] !== value)
					report.errors.push(
						`Explicit toolchain.${key} conflicts with frozen native ${key} literal`,
					);
			}
		}
		if (Object.keys(toolchain).length) raw.toolchain = toolchain;
	}
	const result = buildConfig.safeParse(raw);
	if (!result.success) {
		report.errors.push(
			...result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
		);
		return;
	}
	for (const key of Object.keys(result.data)) {
		if (!report.provenance[key])
			report.provenance[key] =
				raw[key] !== undefined ? "explicit configuration" : "builder default";
	}
	for (const [key, value] of Object.entries(result.data.toolchain)) {
		report.provenance[`toolchain.${key}`] ??=
			input.toolchain?.[
				key as keyof NonNullable<BuildConfigInput["toolchain"]>
			] !== undefined
				? "explicit configuration"
				: `builder default: ${value}`;
	}
	for (const group of [
		"project",
		"packageManager",
		"gradle",
		"source",
	] as const) {
		const resolved = result.data[group];
		if (!resolved) continue;
		const supplied = input[group] as Record<string, unknown> | undefined;
		for (const key of Object.keys(resolved)) {
			const parent = report.provenance[group];
			report.provenance[`${group}.${key}`] ??=
				supplied?.[key] !== undefined
					? "explicit configuration"
					: parent && parent !== "explicit configuration"
						? parent
						: "builder default";
		}
	}
	return result.data;
}

export function validateFrozenSource(
	files: Map<string, string>,
	config: BuildConfig,
	report: PreparationReport,
) {
	const need = (p: string, reason: string) => {
		if (!files.has(p))
			report.errors.push(`Missing frozen input ${p} (${reason})`);
	};
	for (const p of config.source.requiredFiles) need(p, "source.requiredFiles");
	const at = (p: string) => posix.join(config.project.directory, p);
	if (config.project.kind === "gradle") need(at("gradlew"), "Gradle wrapper");
	if (config.project.kind === "expo") need(at("package.json"), "Expo manifest");
	if (files.has("pnpm-workspace.yaml"))
		report.errors.push(
			"pnpm workspaces are unsupported; use a single root package or a supported npm/Bun workspace layout",
		);
	if (files.has("yarn.lock") || files.has(".pnp.cjs"))
		report.errors.push("Yarn/PnP is unsupported");
	if (config.packageManager) {
		need("package.json", "dependency installation runs at repository root");
		const locks = {
			npm: ["package-lock.json", "npm-shrinkwrap.json"],
			bun: ["bun.lock", "bun.lockb"],
			pnpm: ["pnpm-lock.yaml"],
		};
		if (!locks[config.packageManager.kind].some((p) => files.has(p)))
			report.errors.push(
				`Missing frozen ${config.packageManager.kind} lockfile at repository root`,
			);
	}
	const manifests = [...files.keys()].filter(
		(p) => posix.basename(p) === "package.json",
	);
	const packages = new Map<string, { path: string; value: Manifest }>();
	for (const path of manifests) {
		try {
			const value = manifestSchema.parse(JSON.parse(files.get(path) ?? ""));
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw Error();
			packages.set(path, { path, value });
		} catch {
			report.errors.push(`Invalid frozen manifest: ${path}`);
		}
	}
	const workspaces = packages.get("package.json")?.value.workspaces;
	const workspacePaths = new Set<string>();
	if (workspaces !== undefined) {
		if (config.packageManager?.kind === "pnpm")
			report.errors.push("pnpm workspaces are unsupported");
		if (
			!Array.isArray(workspaces) ||
			workspaces.some(
				(w) =>
					typeof w !== "string" ||
					!/^[\w@/-]+(?:\/\*)?$/.test(w) ||
					w.split("/").includes(".."),
			)
		)
			report.errors.push(
				"Supported workspaces are an array of literal directories or one trailing /*",
			);
		else
			for (const pattern of workspaces as string[]) {
				if (!pattern.endsWith("/*")) {
					need(`${pattern}/package.json`, "workspace");
					workspacePaths.add(`${pattern}/package.json`);
				} else {
					const base = pattern.slice(0, -1);
					for (const { path } of report.excluded)
						if (
							path.startsWith(base) &&
							path.endsWith("/package.json") &&
							path.slice(base.length).split("/").length === 2
						)
							need(path, "excluded workspace manifest");
					for (const path of manifests)
						if (
							path.startsWith(base) &&
							path.slice(base.length).split("/").length === 2
						)
							workspacePaths.add(path);
					if (![...workspacePaths].some((p) => p.startsWith(base)))
						report.errors.push(
							`Workspace pattern ${pattern} has no frozen packages`,
						);
				}
			}
		if (
			config.project.directory !== "." &&
			!workspacePaths.has(at("package.json"))
		)
			report.errors.push(
				"Nested JS project must be declared in root workspaces",
			);
	} else if (
		config.packageManager &&
		config.project.kind === "expo" &&
		config.project.directory !== "."
	)
		report.errors.push(
			"Nested Expo projects require root npm/Bun workspaces; nested independent installs are unsupported",
		);
	const workspaceNames = new Set(
		[...workspacePaths].map((p) => packages.get(p)?.value.name).filter(Boolean),
	);
	for (const { path, value } of packages.values()) {
		for (const group of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
		]) {
			for (const [name, spec] of Object.entries(value[group] ?? {})) {
				if (typeof spec !== "string") continue;
				if (spec.startsWith("workspace:")) {
					if (config.packageManager?.kind !== "bun")
						report.errors.push(
							`workspace: protocol requires supported Bun workspaces; use npm-compatible local/version dependencies in ${path}`,
						);
					if (!workspaceNames.has(name))
						report.errors.push(
							`Missing frozen workspace ${name} declared by ${path}`,
						);
					continue;
				}
				if (spec.startsWith("link:") || spec.startsWith("portal:")) {
					report.errors.push(
						`Unsupported local protocol ${spec} in ${path}; use file:`,
					);
					continue;
				}
				if (/^(?:\.\.?\/|\/|[A-Za-z]:[\\/])/.test(spec)) {
					report.errors.push(
						`Unsupported shorthand local dependency ${spec} in ${path}; use file:`,
					);
					continue;
				}
				if (!spec.startsWith("file:")) continue;
				const local = spec.slice(5),
					target = posix.normalize(posix.join(posix.dirname(path), local));
				report.localDependencies.push({
					manifest: path,
					specifier: spec,
					target,
				});
				if (
					!local ||
					local.startsWith("/") ||
					local.includes("\\") ||
					target === ".." ||
					target.startsWith("../")
				)
					report.errors.push(
						`Local dependency escapes frozen repository: ${spec} in ${path}`,
					);
				else if (!files.has(target) && !files.has(`${target}/package.json`))
					report.errors.push(
						`Missing frozen local dependency ${target} declared by ${path}`,
					);
				else if (files.has(`${target}/package.json`)) {
					const dependency = packages.get(`${target}/package.json`)?.value;
					const entry = (value: unknown) => {
						if (
							typeof value === "string" &&
							(value.startsWith("./") || !value.startsWith("#"))
						) {
							if (value.includes("*")) {
								report.warnings.push(
									`Dynamic entry glob ${value} in ${target}/package.json requires manual manifest review`,
								);
								return;
							}
							const p = posix.normalize(posix.join(target, value));
							if (!p.startsWith(`${target}/`))
								report.errors.push(
									`Local dependency entry escapes package: ${value} in ${target}/package.json`,
								);
							else if (
								![p, `${p}.js`, `${p}.json`, `${p}/index.js`].some((f) =>
									files.has(f),
								)
							)
								report.errors.push(
									`Missing frozen local dependency entry ${p}; generated package outputs are not built during preparation`,
								);
						} else if (value && typeof value === "object")
							for (const v of Object.values(value)) entry(v);
					};
					for (const field of ["main", "module", "types", "exports", "bin"])
						if (dependency?.[field]) entry(dependency[field]);
				}
			}
		}
		for (const [name, spec] of Object.entries(
			value.patchedDependencies ?? value.pnpm?.patchedDependencies ?? {},
		)) {
			if (typeof spec === "string")
				need(posix.join(posix.dirname(path), spec), `patch for ${name}`);
		}
	}
	for (const { path } of report.excluded)
		if (
			/(?:^|\/)(?:\.npmrc|gradle\.properties|pnpm-workspace\.yaml)$/.test(path)
		)
			report.warnings.push(
				`Excluded tool configuration: ${path}; review and explicitly require/include public configuration if needed`,
			);
	report.relevantInputs = [...files.keys()].filter(
		(p) =>
			/(?:^|\/)(?:package\.json|(?:babel|metro|react-native|expo)\.config\.[cm]?[jt]s|(?:build|settings)\.gradle(?:\.kts)?|.*lock.*|npm-shrinkwrap\.json|pnpm-workspace\.yaml|gradle\.properties|gradle-wrapper\.properties|app\.json|app\.config\.[jt]s|tsconfig[^/]*\.json|\.npmrc|\.yarnrc.*)$/.test(
				p,
			) ||
			p.endsWith(".patch") ||
			/(?:^|\/)patches\//.test(p),
	);
}
