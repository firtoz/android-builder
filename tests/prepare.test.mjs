import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exec } from "../dist/files.js";
import { defineBuildConfig, prepareBuild } from "../dist/index.js";

test("generic source preparation preserves exact tracked bytes and optional public inputs without a cloud request", async () => {
	const base = await mkdtemp(join(tmpdir(), "android-source-"));
	try {
		const root = join(base, "project"),
			licenses = join(base, "licenses");
		await mkdir(root);
		await mkdir(licenses);
		await writeFile(
			join(licenses, "android-sdk-license"),
			`${"a".repeat(40)}\n`,
		);
		await writeFile(join(root, "gradlew"), "#!/bin/sh\nprintf hi\n", {
			mode: 0o755,
		});
		await writeFile(join(root, "unicode.txt"), "こんにちは 😀\u0000\n");
		await writeFile(join(root, "empty"), "");
		await writeFile(join(root, ".env.local"), "NOT_FOR_TRANSFER=fixture");
		await writeFile(
			join(root, "client-public.json"),
			'{"project":"public-fixture"}',
		);
		await exec("git", ["init", "--quiet"], { cwd: root });
		await exec(
			"git",
			["add", "gradlew", "unicode.txt", "empty", ".env.local"],
			{ cwd: root },
		);
		await exec(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.test",
				"commit",
				"-qm",
				"fixture",
			],
			{ cwd: root },
		);
		const directory = join(base, "receipt");
		const journal = await prepareBuild({
			root,
			directory,
			licensesDirectory: licenses,
			config: defineBuildConfig({
				project: { kind: "gradle" },
				artifact: "app.apk",
				applicationId: "org.example.hello",
				reservationUsd: 0.2,
				publicInputs: [
					{ source: "client-public.json", target: "app/google-services.json" },
				],
			}),
		});
		assert.equal(journal.state, "prepared");
		assert.equal(journal.hostId, undefined);
		const manifest = JSON.parse(
			await readFile(join(directory, "source-manifest.json"), "utf8"),
		);
		assert.deepEqual(
			manifest.map((x) => x.path),
			["empty", "gradlew", "unicode.txt"],
		);
		assert.equal(manifest.find((x) => x.path === "gradlew").mode, 0o755);
		assert.equal(manifest.find((x) => x.path === "empty").bytes, 0);
		const extracted = join(base, "extracted");
		await mkdir(extracted);
		await exec("tar", ["-xzf", join(directory, "source.tgz"), "-C", extracted]);
		assert.deepEqual(
			await readFile(join(extracted, "unicode.txt")),
			await readFile(join(root, "unicode.txt")),
		);
		assert.deepEqual(
			await readFile(join(directory, "public-0.input")),
			await readFile(join(root, "client-public.json")),
		);
		const hostConfig = JSON.parse(
			await readFile(join(directory, "config.json"), "utf8"),
		);
		assert.deepEqual(hostConfig.publicInputs, [
			{ name: "public-0.input", target: "app/google-services.json" },
		]);
		await assert.rejects(
			prepareBuild({
				root,
				directory,
				licensesDirectory: licenses,
				config: journal.config,
			}),
			/EEXIST/,
		);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
