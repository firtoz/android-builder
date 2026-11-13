import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ANDROID_BUILD, buildJournal, sha256 } from "./contracts.js";
import {
	type PreparationConfig,
	type PreparationReport,
	reportLimits,
	resolveConfiguration,
	validateFrozenSource,
	validatePreparationInput,
} from "./diagnostics.js";
import { BuildError } from "./errors.js";
import { atomicJson, exec, saveJournal } from "./files.js";

export function sourceAllowed(path: string): boolean {
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((p) => !p || p === "." || p === "..")
	)
		return false;
	if (
		path
			.split("/")
			.some(
				(p) =>
					p.startsWith(".") ||
					["node_modules", "dist", "coverage", "build"].includes(p),
			)
	)
		return false;
	if (
		/(?:^|\/)(?:google-services[^/]*\.json|credentials\.json|GoogleService-Info[^/]*\.plist)$/.test(
			path,
		)
	)
		return false;
	return !/\.(?:pem|key|p12|jks|keystore|p8|mobileprovision|sqlite|db|apk|aab|log)$/i.test(
		path,
	);
}
/** Exact opt-ins permit only public .npmrc among hidden inputs. */
export function sourceExclusion(
	path: string,
	explicit = false,
): string | undefined {
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((p) => !p || p === "." || p === "..")
	)
		return "unsafe path";
	if (
		path
			.split("/")
			.some(
				(p) =>
					p.startsWith(".") &&
					!(
						explicit &&
						p === ".npmrc" &&
						path.split("/").at(-1) === p &&
						path.split("/").filter((v) => v.startsWith(".")).length === 1
					),
			)
	)
		return "hidden path (only exact public .npmrc opt-in is supported)";
	if (
		!sourceAllowed(path) &&
		!(
			explicit &&
			path.split("/").at(-1) === ".npmrc" &&
			sourceAllowed(path.replaceAll(".npmrc", "npmrc"))
		)
	)
		return "credential, dependency or generated output exclusion";
	return;
}
export interface PrepareOptions {
	root: string;
	directory: string;
	config: PreparationConfig;
	licensesDirectory: string;
	id?: string;
	owner?: string;
	/** Optional further allowlist. Default includes safe Git-tracked files only. */
	include?: (path: string) => boolean;
}
export async function prepareBuild(options: PrepareOptions) {
	validatePreparationInput(options.config);
	const requestedRoot = await realpath(options.root);
	const root = await realpath(
		(
			await exec("git", ["rev-parse", "--show-toplevel"], {
				cwd: requestedRoot,
			})
		).stdout.trim(),
	);
	const directory = resolve(options.directory);
	const id = z.uuid().parse(options.id ?? randomUUID()),
		owner = z.uuid().parse(options.owner ?? randomUUID());
	if (directory === root || root.startsWith(`${directory}${sep}`))
		throw Error("Build receipts must not contain the source repository");
	const licenses = await realpath(options.licensesDirectory),
		licenseNames = await readdir(licenses);
	if (
		!licenseNames.length ||
		licenseNames.some((n) => !/^[a-zA-Z0-9-]+$/.test(n))
	)
		throw Error("Supply an existing accepted SDK licenses directory");
	await mkdir(directory, { mode: 0o700 });
	const snapshot = join(directory, "source");
	await mkdir(snapshot, { mode: 0o700 });
	const listed = await exec("git", ["ls-files", "-z", "--cached"], {
		cwd: root,
		maxBuffer: 8 * 1024 * 1024,
	});
	const others = await exec(
		"git",
		["ls-files", "-z", "--others", "--exclude-standard"],
		{ cwd: root, maxBuffer: 8 * 1024 * 1024 },
	);
	const sourceCommit = (
		await exec("git", ["rev-parse", "HEAD"], { cwd: root })
	).stdout.trim();
	const objectFormat = (
		await exec("git", ["rev-parse", "--show-object-format"], { cwd: root })
	).stdout.trim();
	const headEntries = new Map(
		(
			await exec("git", ["ls-tree", "-rz", sourceCommit], {
				cwd: root,
				maxBuffer: 8 * 1024 * 1024,
			})
		).stdout
			.split("\0")
			.filter(Boolean)
			.map((entry) => {
				const [metadata, ...path] = entry.split("\t"),
					[mode, , hash] = (metadata ?? "").split(" ");
				return [path.join("\t"), { mode, hash }] as const;
			}),
	);
	const report: PreparationReport = {
		version: 1,
		id,
		directory,
		repositoryRoot: root,
		projectDirectory: resolve(root, options.config.project.directory ?? "."),
		sourceCommit,
		workingTree: false,
		sourceDescription:
			"Git-tracked working-tree bytes matching HEAD for selected files",
		included: [],
		excluded: [],
		relevantInputs: [],
		localDependencies: [],
		errors: [],
		warnings: [
			"Ignored untracked files are not enumerated; extraFiles can name exact public inputs.",
			"Preparation freezes files one by one; avoid editing source during preparation. HEAD comparison uses the exact frozen bytes.",
		],
		provenance: {},
		limits: reportLimits,
	};
	const files: { path: string; bytes: number; sha256: string; mode: number }[] =
		[];
	const frozenFiles = new Map<string, string>();
	const extra = options.config.source?.extraFiles ?? [];
	const tracked = new Set(listed.stdout.split("\0").filter(Boolean));
	const candidates = new Set([
		...tracked,
		...others.stdout.split("\0").filter(Boolean),
		...extra,
	]);
	let total = 0;
	for (const path of [...candidates].sort()) {
		const explicit = extra.includes(path);
		const reason =
			sourceExclusion(path, explicit) ??
			(!tracked.has(path) && !explicit
				? "untracked (not explicitly included)"
				: undefined) ??
			(options.include && !options.include(path)
				? "consumer include filter"
				: undefined);
		if (reason) {
			report.excluded.push({ path, reason });
			if (explicit)
				report.errors.push(
					`Explicit extra input excluded: ${path} (${reason})`,
				);
			continue;
		}
		try {
			for (
				let parent = dirname(path);
				parent !== ".";
				parent = dirname(parent)
			) {
				if ((await lstat(join(root, parent))).isSymbolicLink())
					throw Error("Symlink ancestor");
			}
			const original = join(root, path),
				stat = await lstat(original);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				!(await realpath(original)).startsWith(`${root}${sep}`)
			) {
				report.errors.push(
					`Unsupported symlink, submodule or non-regular source: ${path}`,
				);
				continue;
			}
			total += stat.size;
			if (total > 256 * 1024 * 1024 || files.length >= 20000)
				throw new BuildError(
					"PREPARATION_FAILED",
					"Source snapshot exceeds bounds",
				);
			const target = join(snapshot, path);
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			await copyFile(original, target);
			const bytes = await readFile(target),
				mode = stat.mode & 0o111 ? 0o755 : 0o644;
			await chmod(target, mode);
			files.push({ path, bytes: bytes.length, sha256: sha256(bytes), mode });
			frozenFiles.set(path, bytes.toString("utf8"));
			const head = headEntries.get(path),
				blob = createHash(objectFormat)
					.update(`blob ${bytes.length}\0`)
					.update(bytes)
					.digest("hex");
			if (head?.hash !== blob || (head?.mode === "100755") !== (mode === 0o755))
				report.workingTree = true;
			if (
				bytes
					.subarray(0, 100)
					.toString()
					.startsWith("version https://git-lfs.github.com/spec/v1")
			)
				report.errors.push(
					`Unsupported Git LFS pointer: ${path}; materialize and review source first`,
				);
			if (
				path.split("/").at(-1) === ".npmrc" &&
				/_auth|password|token|\$\{|https?:\/\/[^/\s]+@/i.test(bytes.toString())
			)
				report.errors.push(
					`Credential-bearing or environment-dependent .npmrc is not a public build input: ${path}`,
				);
		} catch (error) {
			if (error instanceof BuildError) throw error;
			report.errors.push(`Cannot freeze regular source file: ${path}`);
		}
	}
	report.included = files.map((f) => f.path);
	if (report.workingTree)
		report.sourceDescription =
			"Modified tracked working-tree contents and/or explicitly included untracked inputs; not a HEAD checkout";
	const config = resolveConfiguration(options.config, frozenFiles, report);
	if (config) validateFrozenSource(frozenFiles, config, report);
	report.resolved = config;
	await atomicJson(join(directory, "preparation-report.json"), report);
	await atomicJson(join(directory, "source-manifest.json"), files);
	if (!config || report.errors.length) {
		await rm(snapshot, { recursive: true });
		throw new BuildError(
			"PREPARATION_FAILED",
			`Preparation failed; no host allocated. Review ${join(directory, "preparation-report.json")}: ${report.errors.join("; ")}`,
		);
	}
	const workingTree = report.workingTree;
	await atomicJson(join(directory, "source-manifest.json"), files);
	const output = join(directory, "licenses");
	await mkdir(output, { mode: 0o700 });
	for (const name of licenseNames) {
		const original = join(licenses, name);
		if (!(await lstat(original)).isFile())
			throw Error("SDK license must be a regular file");
		const bytes = await readFile(original, "utf8");
		if (
			bytes.length > 4096 ||
			!bytes
				.trim()
				.split(/\s+/)
				.every((v) => /^[a-f0-9]{40}$/.test(v))
		)
			throw Error("Unexpected SDK license hash file");
		await writeFile(join(output, name), bytes, { mode: 0o600 });
	}
	await exec("tar", [
		"-czf",
		join(directory, "source.tgz"),
		"-C",
		snapshot,
		".",
	]);
	await exec("tar", [
		"-czf",
		join(directory, "licenses.tgz"),
		"-C",
		directory,
		"licenses",
	]);
	const names = [
		"source.tgz",
		"source-manifest.json",
		"licenses.tgz",
		"host.py",
		"build.sh",
		"config.json",
	];
	const publicInputs: { name: string; target: string }[] = [];
	for (const [index, input] of config.publicInputs.entries()) {
		if (
			input.target === "." ||
			input.target
				.split("/")
				.some((p) => p.startsWith(".") || p === "node_modules") ||
			/\.(?:pem|key|p12|jks|keystore|p8)$/i.test(input.target) ||
			files.some((f) => f.path === input.target) ||
			publicInputs.some((i) => i.target === input.target)
		)
			throw Error("Public input must have a unique, safe, untracked target");
		const path = resolve(root, input.source);
		if (!(await lstat(path)).isFile())
			throw Error("Public input must be a regular file");
		const name = `public-${index}.input`;
		await copyFile(path, join(directory, name));
		names.push(name);
		publicInputs.push({ name, target: input.target });
	}
	await copyFile(
		fileURLToPath(new URL("../host/host.py", import.meta.url)),
		join(directory, "host.py"),
	);
	await copyFile(
		fileURLToPath(new URL("../host/build.sh", import.meta.url)),
		join(directory, "build.sh"),
	);
	// Source paths are controller-local and are never required on the host.
	const frozen = { ...config, publicInputs };
	await atomicJson(join(directory, "config.json"), frozen);
	const inputs = [];
	for (const name of names) {
		const bytes = await readFile(join(directory, name));
		if (!bytes.length || bytes.length > ANDROID_BUILD.maxSourceBytes)
			throw Error(`Input exceeds bound: ${name}`);
		await chmod(join(directory, name), 0o600);
		inputs.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
	}
	const journal = buildJournal.parse({
		version: 1,
		id,
		owner,
		preparedAt: Date.now(),
		sourceHash: sha256(JSON.stringify(files)),
		sourceCommit,
		workingTree,
		config,
		inputs,
		state: "prepared",
	});
	await saveJournal(directory, journal);
	await rm(snapshot, { recursive: true });
	return journal;
}
