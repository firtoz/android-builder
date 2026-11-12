import { randomUUID } from "node:crypto";
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
import {
	ANDROID_BUILD,
	type BuildConfigInput,
	buildConfig,
	buildJournal,
	sha256,
} from "./contracts.js";
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
export interface PrepareOptions {
	root: string;
	directory: string;
	config: BuildConfigInput;
	licensesDirectory: string;
	id?: string;
	owner?: string;
	/** Optional further allowlist. Default includes safe Git-tracked files only. */
	include?: (path: string) => boolean;
}
export async function prepareBuild(options: PrepareOptions) {
	const config = buildConfig.parse(options.config),
		root = await realpath(options.root),
		directory = resolve(options.directory);
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
	const files: { path: string; bytes: number; sha256: string; mode: number }[] =
		[];
	let total = 0;
	for (const path of [
		...new Set(
			listed.stdout
				.split("\0")
				.filter(
					(p) => sourceAllowed(p) && (!options.include || options.include(p)),
				),
		),
	].sort()) {
		const original = join(root, path),
			stat = await lstat(original);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			!(await realpath(original)).startsWith(`${root}${sep}`)
		)
			throw Error(`Source must be a regular in-repository file: ${path}`);
		total += stat.size;
		if (total > 256 * 1024 * 1024 || files.length >= 20000)
			throw Error("Source snapshot exceeds bounds");
		const target = join(snapshot, path);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await copyFile(original, target);
		const bytes = await readFile(target),
			mode = stat.mode & 0o111 ? 0o755 : 0o644;
		await chmod(target, mode);
		files.push({ path, bytes: bytes.length, sha256: sha256(bytes), mode });
	}
	const required = join(config.project.directory, "gradlew")
		.split(sep)
		.join("/");
	if (
		!files.length ||
		(config.project.kind === "gradle" &&
			!files.some((f) => f.path === required)) ||
		(config.project.kind === "expo" &&
			!files.some((f) => f.path === "package.json"))
	)
		throw Error("Incomplete source snapshot for this project profile");
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
	const sourceCommit = (
		await exec("git", ["rev-parse", "HEAD"], { cwd: root })
	).stdout.trim();
	const workingTree =
		(await exec("git", ["status", "--porcelain"], { cwd: root })).stdout
			.length > 0;
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
