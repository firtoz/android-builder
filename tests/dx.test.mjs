import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { buildJournal, sha256 } from "../dist/contracts.js";
import { exec, saveJournal } from "../dist/files.js";
import {
	BuildError,
	createBuilder,
	defineProjectConfig,
	prepareBuild,
} from "../dist/index.js";

async function sourceFixture(run) {
	const base = await mkdtemp(join(tmpdir(), "builder-dx-"));
	const root = join(base, "repo"),
		licensesDirectory = join(base, "licenses");
	await mkdir(root);
	await mkdir(licensesDirectory);
	const put = async (p, value) => {
		await mkdir(dirname(join(root, p)), { recursive: true });
		await writeFile(
			join(root, p),
			typeof value === "string" ? value : JSON.stringify(value),
		);
	};
	await writeFile(
		join(licensesDirectory, "android-sdk-license"),
		"a".repeat(40),
	);
	await put("gradlew", "#!/bin/sh\nexit 0\n");
	await put(
		"app/build.gradle",
		'android { compileSdk 36; buildToolsVersion "36.0.0"; defaultConfig { applicationId "org.example.hello" } }',
	);
	await exec("git", ["init", "-q"], { cwd: root });
	const commit = async () => {
		await exec("git", ["add", "."], { cwd: root });
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
	};
	await commit();
	const config = defineProjectConfig({
		project: { kind: "gradle" },
		admissionAllowanceUsd: 0.2,
	});
	let n = 0;
	const prepare = async (overrides = {}) => {
		const directory = join(base, `receipt-${++n}`);
		try {
			const journal = await prepareBuild({
				root,
				licensesDirectory,
				config,
				directory,
				...overrides,
			});
			return {
				directory,
				journal,
				report: JSON.parse(
					await readFile(join(directory, "preparation-report.json"), "utf8"),
				),
			};
		} catch (error) {
			error.report = JSON.parse(
				await readFile(
					join(directory, "preparation-report.json"),
					"utf8",
				).catch(() => "null"),
			);
			throw error;
		}
	};
	try {
		await run({ base, root, put, commit, config, prepare, licensesDirectory });
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

test("resolved config uses exact frozen bytes, tracks edits, and records provenance", () =>
	sourceFixture(async ({ root, put, prepare }) => {
		await put("untracked.txt", "omitted");
		const first = await prepare();
		assert.equal(first.journal.workingTree, false);
		assert.equal(first.journal.config.applicationId, "org.example.hello");
		assert.equal(
			first.journal.config.artifact,
			"app/build/outputs/apk/debug/app-debug.apk",
		);
		assert.match(first.report.provenance.applicationId, /literal/);
		assert.match(first.report.provenance["toolchain.sdk"], /literal/);
		assert.equal(first.report.provenance["gradle.tasks"], "builder default");
		assert.equal(
			first.report.provenance["project.directory"],
			"builder default",
		);
		assert.equal(first.report.repositoryRoot, root);
		assert.match(
			first.report.excluded.find((f) => f.path === "untracked.txt").reason,
			/untracked/,
		);
		await put("gradlew", "modified\n");
		assert.equal((await prepare()).journal.workingTree, true);
	}));

test("local dependencies resolve from their declaring manifests; excluded targets and entries fail before allocation", () =>
	sourceFixture(async ({ put, commit, prepare }) => {
		await put("package.json", {
			packageManager: "npm@11.10.1",
			workspaces: ["apps/*", "packages/*"],
		});
		await put("package-lock.json", {});
		await put("apps/mobile/package.json", {
			dependencies: {
				lib: "file:../../packages/lib",
				archive: "file:../../vendor/lib.tgz",
			},
		});
		await put("packages/lib/package.json", { name: "lib", main: "index.js" });
		await put("packages/lib/index.js", "export default 1;");
		await put("vendor/lib.tgz", "fixture archive");
		await commit();
		const result = await prepare();
		assert.deepEqual(
			result.report.localDependencies.map((v) => v.target).sort(),
			["packages/lib", "vendor/lib.tgz"],
		);
		await assert.rejects(
			prepare({ include: (p) => p !== "vendor/lib.tgz" }),
			(e) =>
				e.code === "PREPARATION_FAILED" &&
				/Missing frozen local dependency vendor/.test(e.message),
		);
		await assert.rejects(
			prepare({ include: (p) => p !== "packages/lib/index.js" }),
			/Missing frozen local dependency entry/,
		);
		await assert.rejects(
			prepare({ include: (p) => p !== "packages/lib/package.json" }),
			/workspace manifest|local dependency/,
		);
		await put("apps/mobile/package.json", {
			dependencies: { missing: "file:../../../outside.tgz" },
		});
		await assert.rejects(prepare(), /escapes frozen repository/);
	}));

test("safe exact extras and required paths preserve hidden credential exclusions", () =>
	sourceFixture(async ({ put, config, prepare }) => {
		await put(".npmrc", "fund=false\n");
		await put("extra.txt", "public source");
		const selected = {
			...config,
			source: {
				extraFiles: [".npmrc", "extra.txt"],
				requiredFiles: [".npmrc", "extra.txt"],
			},
		};
		assert.ok(
			(await prepare({ config: selected })).report.included.includes(".npmrc"),
		);
		await assert.rejects(
			prepare({
				config: { ...config, source: { requiredFiles: ["extra.txt"] } },
			}),
			/Missing frozen input extra.txt/,
		);
		await put(".npmrc", "//registry.example.test/:_authToken=fixture\n");
		await assert.rejects(prepare({ config: selected }), /Credential-bearing/);
		await put(".env", "secret fixture");
		await assert.rejects(
			prepare({ config: { ...config, source: { extraFiles: [".env"] } } }),
			/Explicit extra input excluded/,
		);
	}));

test("unsupported source and package manager layouts are explicit", () =>
	sourceFixture(async ({ root, put, commit, prepare }) => {
		await symlink("gradlew", join(root, "linked"));
		await commit();
		await assert.rejects(prepare(), /Unsupported symlink/);
		await rm(join(root, "linked"));
		await exec("git", ["add", "-u"], { cwd: root });
		await put(
			"large.txt",
			"version https://git-lfs.github.com/spec/v1\noid sha256:fixture\n",
		);
		await commit();
		await assert.rejects(prepare(), /Git LFS pointer/);
		await rm(join(root, "large.txt"));
		await exec("git", ["add", "-u"], { cwd: root });
		await put("package.json", { packageManager: "pnpm@10.0.0" });
		await put("pnpm-lock.yaml", "fixture");
		await put("pnpm-workspace.yaml", "packages: [apps/*]");
		await commit();
		await assert.rejects(prepare(), /pnpm workspaces are unsupported/);
	}));

test("nested Expo workspace config derives static identity and never executes discovery scripts", () =>
	sourceFixture(async ({ put, commit, config, prepare }) => {
		await put("package.json", {
			packageManager: "bun@1.4.4",
			workspaces: ["apps/*", "packages/*"],
		});
		await put("bun.lock", "fixture");
		await put("apps/mobile/package.json", {
			name: "mobile",
			dependencies: { expo: "57.0.25", lib: "workspace:*" },
		});
		await put("apps/mobile/app.json", {
			expo: { android: { package: "org.example.mobile" } },
		});
		await put("packages/lib/package.json", { name: "lib" });
		await put(
			"apps/mobile/app.config.ts",
			'throw new Error("must not execute");',
		);
		await commit();
		const expo = {
			...config,
			project: { kind: "expo", directory: "apps/mobile" },
		};
		await assert.rejects(
			prepare({ config: expo }),
			/Dynamic Expo configuration requires explicit applicationId/,
		);
		const result = await prepare({
			config: { ...expo, applicationId: "org.example.mobile" },
		});
		assert.equal(result.journal.config.packageManager.kind, "bun");
		assert.match(result.journal.config.artifact, /^apps\/mobile\/android\//);
		await assert.rejects(
			prepare({ config: { ...expo, applicationId: "org.example.wrong" } }),
			/conflicts/,
		);
	}));

async function handleFixture(run) {
	const directory = await mkdtemp(join(tmpdir(), "builder-handle-"));
	const apk = Buffer.from("simulated APK only");
	const journal = buildJournal.parse({
		version: 1,
		id: randomUUID(),
		owner: randomUUID(),
		preparedAt: Date.now(),
		sourceHash: sha256("source"),
		sourceCommit: "a".repeat(40),
		workingTree: false,
		config: {
			project: { kind: "gradle" },
			artifact: "app.apk",
			applicationId: "org.example.hello",
			reservationUsd: 0.2,
		},
		inputs: [{ name: "source.tgz", bytes: 6, sha256: sha256("source") }],
		state: "prepared",
	});
	await writeFile(join(directory, "source.tgz"), "source");
	await saveJournal(directory, journal);
	await writeFile(
		join(directory, "provider.json"),
		JSON.stringify({ version: 1, id: "fixture:large" }),
	);
	const stats = { opened: 0, closed: 0, allocated: 0, launched: 0, retired: 0 };
	const flags = {
		lostAck: false,
		corrupt: false,
		cleanup: false,
		fail: false,
		absent: false,
	};
	const provider = {
		id: "fixture:large",
		open: async () => {
			stats.opened++;
			return {
				close: () => {
					stats.closed++;
				},
				transport: {
					allocate: async () => {
						stats.allocated++;
						return "owned_fixture";
					},
					ready: async () => {},
					upload: async () => {},
					command: async (_host, cmd) => {
						if (flags.absent)
							throw new BuildError("REMOTE_GONE", "Host absent");
						if (cmd.endsWith(" launch")) {
							stats.launched++;
							if (flags.lostAck) throw Error("lost ack");
						}
						if (cmd.includes(" observe "))
							return JSON.stringify({
								cursor: 0,
								log: "",
								claimed: true,
								status: {
									state: flags.fail ? "failed" : "complete",
									phase: "compile",
									artifact: flags.fail
										? undefined
										: { bytes: apk.length, sha256: sha256(apk) },
								},
							});
						return "";
					},
					download: async (_h, _p, _b, target) =>
						writeFile(target, flags.corrupt ? "corrupt" : apk),
					retire: async () => {
						stats.retired++;
						if (flags.cleanup) throw Error("lost retirement ack");
					},
				},
			};
		},
	};
	const builder = createBuilder({ provider });
	try {
		await run({ directory, journal, flags, stats, builder, provider });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("handle owns adapter lifetime, refuses implicit start, recovers lost acknowledgement, and verifies local artifact", () =>
	handleFixture(async ({ directory, builder, stats, flags }) => {
		let build = await builder.reconnect({ directory });
		assert.equal((await build.inspect()).work, "not-started");
		await assert.rejects(build.observe(), (e) => e.code === "INVALID_STATE");
		await assert.rejects(
			build.start({ admitUsd: 0.1 }),
			(e) => e.code === "INVALID_INPUT" && e.build.id === build.id,
		);
		assert.equal(stats.allocated, 0);
		flags.lostAck = true;
		await assert.rejects(
			build.start({ admitUsd: 0.2 }),
			(e) =>
				e.code === "LAUNCH_UNCERTAIN" && /observe/.test(e.build.nextCommand),
		);
		build = await builder.reconnect({ directory });
		await build.observe();
		assert.equal(stats.allocated, 1);
		assert.equal(stats.launched, 1);
		assert.equal(stats.opened, stats.closed);
		assert.equal(await build.artifact(), join(directory, "artifact.apk"));
		await writeFile(join(directory, "artifact.apk"), "changed");
		await assert.rejects(
			build.artifact(),
			(e) => e.code === "ARTIFACT_VERIFICATION_FAILED",
		);
	}));

test("work outcome stays separate from unconfirmed cleanup, corruption and remote absence", () =>
	handleFixture(async ({ directory, builder, flags, stats }) => {
		const build = await builder.reconnect({ directory });
		flags.corrupt = true;
		await assert.rejects(
			build.start({ admitUsd: 0.2 }),
			(e) =>
				e.code === "ARTIFACT_VERIFICATION_FAILED" &&
				e.build.work === "complete" &&
				e.build.cleanup === "unresolved",
		);
		assert.equal(stats.retired, 0);
		flags.corrupt = false;
		flags.cleanup = true;
		await assert.rejects(
			build.observe(),
			(e) =>
				e.code === "RETIREMENT_UNCONFIRMED" &&
				e.build.artifact &&
				e.build.cleanup === "unresolved",
		);
		flags.cleanup = false;
		assert.equal((await build.retire()).cleanup, "retired");
	}));

test("provider mismatch and confirmed absence cannot allocate a replacement", () =>
	handleFixture(async ({ directory, builder, journal, flags, stats }) => {
		const other = await createBuilder().reconnect({ directory });
		assert.equal((await other.inspect()).provider, "fixture:large");
		await assert.rejects(
			other.start({ admitUsd: 0.2 }),
			(e) => e.code === "INVALID_INPUT",
		);
		await saveJournal(directory, {
			...journal,
			state: "running",
			hostId: "owned_fixture",
			expiresAt: Date.now() + 600000,
		});
		flags.absent = true;
		const build = await builder.reconnect({ directory });
		await assert.rejects(
			build.observe(),
			(e) =>
				e.code === "REMOTE_GONE" &&
				e.build.journal.hostAbsent &&
				!e.build.artifact,
		);
		assert.equal(stats.allocated, 0);
	}));

const cli = resolve("dist/cli.js");
test("CLI help, human default, JSON failure codes and offline preparation/inspection", () =>
	sourceFixture(async ({ root, config, licensesDirectory, base }) => {
		const help = (await exec(process.execPath, [cli, "--help"])).stdout;
		assert.match(help, /never launch/);
		assert.match(help, /NOT a price quote/);
		const configPath = join(base, "config.json"),
			directory = join(base, "cli-receipt");
		await writeFile(configPath, JSON.stringify(config));
		const prep = JSON.parse(
			(
				await exec(process.execPath, [
					cli,
					"prepare",
					"--root",
					root,
					"--config",
					configPath,
					"--licenses",
					licensesDirectory,
					"--directory",
					directory,
					"--json",
				])
			).stdout,
		);
		assert.equal(prep.version, 1);
		assert.equal(prep.ok, true);
		assert.equal(prep.build.work, "not-started");
		const inspect = (
			await exec(process.execPath, [cli, "inspect", "--directory", directory])
		).stdout;
		assert.match(inspect, /Offline inspection only/);
		try {
			await exec(process.execPath, [
				cli,
				"start",
				"--directory",
				directory,
				"--admit-usd",
				"0.01",
				"--json",
			]);
			assert.fail("must reject");
		} catch (e) {
			const result = JSON.parse(e.stdout);
			assert.equal(e.code, 2);
			assert.equal(result.error.code, "INVALID_INPUT");
			assert.equal(result.build.id, prep.build.id);
			assert.match(result.build.nextCommand, /start/);
		}
	}));

test("submodules and static configuration contradictions fail preflight", () =>
	sourceFixture(async ({ root, put, config, prepare }) => {
		await put("module/placeholder.txt", "fixture");
		const head = (
			await exec("git", ["rev-parse", "HEAD"], { cwd: root })
		).stdout.trim();
		await exec(
			"git",
			["update-index", "--add", "--cacheinfo", `160000,${head},module`],
			{ cwd: root },
		);
		await assert.rejects(prepare(), /submodule/);
		await exec("git", ["rm", "--cached", "-f", "module"], { cwd: root });
		await assert.rejects(
			prepare({ config: { ...config, toolchain: { sdk: 35 } } }),
			/toolchain.sdk conflicts/,
		);
		await assert.rejects(
			prepare({
				config: { ...config, gradle: { tasks: [":app:bundleRelease"] } },
			}),
			/release\/AAB/,
		);
		await assert.rejects(
			prepare({
				config: {
					...config,
					artifact: "app/build/outputs/apk/demo/app-demo.apk",
				},
			}),
			/contradicts/,
		);
		await put(
			"app/build.gradle",
			'// applicationId "org.example.comment"\nandroid { defaultConfig { applicationId project.env.ID } }',
		);
		await assert.rejects(prepare(), /not unambiguous/);
	}));

test("CLI custom provider reports compiler failure and verified artifact with unresolved retirement as JSON", () =>
	sourceFixture(async ({ root, config, licensesDirectory, base }) => {
		const modulePath = join(base, "provider.mjs"),
			configPath = join(base, "config.json");
		await writeFile(configPath, JSON.stringify(config));
		await writeFile(
			modulePath,
			`import {writeFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const apk=Buffer.from('simulated artifact');
export const provider={id:'fixture:cli',open:async()=>({close:()=>{},transport:{allocate:async()=> 'owned_fixture',ready:async()=>{},upload:async()=>{},command:async(_h,text)=>text.includes(' observe ')?JSON.stringify({cursor:0,log:'',claimed:true,status:{state:process.env.FIXTURE_BUILD_FAIL?'failed':'complete',phase:'compile',artifact:process.env.FIXTURE_BUILD_FAIL?undefined:{bytes:apk.length,sha256:createHash('sha256').update(apk).digest('hex')}}}):'',download:async(_h,_p,_n,target)=>writeFile(target,apk),retire:async()=>{if(process.env.FIXTURE_RETIRE_FAIL)throw Error('unconfirmed')}}})};`,
		);
		for (const mode of ["BUILD", "RETIRE"]) {
			const directory = join(base, `${mode}-receipt`);
			await exec(process.execPath, [
				cli,
				"prepare",
				"--root",
				root,
				"--config",
				configPath,
				"--licenses",
				licensesDirectory,
				"--directory",
				directory,
				"--provider-module",
				modulePath,
				"--json",
			]);
			try {
				await exec(
					process.execPath,
					[
						cli,
						"start",
						"--directory",
						directory,
						"--admit-usd",
						"0.20",
						"--provider-module",
						modulePath,
						"--json",
					],
					{ env: { ...process.env, [`FIXTURE_${mode}_FAIL`]: "1" } },
				);
				assert.fail("must fail");
			} catch (e) {
				assert.equal(e.code, 1);
				const result = JSON.parse(e.stdout);
				assert.equal(result.ok, false);
				assert.equal(
					result.error.code,
					mode === "BUILD" ? "BUILD_FAILED" : "RETIREMENT_UNCONFIRMED",
				);
				assert.equal(
					result.build.work,
					mode === "BUILD" ? "failed" : "complete",
				);
				assert.equal(
					result.build.cleanup,
					mode === "BUILD" ? "retired" : "unresolved",
				);
				if (mode === "RETIRE") assert.ok(result.build.artifact);
			}
		}
	}));

test("allocation uncertainty retains admission and identical durable operation identity", () =>
	handleFixture(async ({ directory, provider, builder, stats }) => {
		const open = provider.open,
			calls = [];
		let first = true;
		provider.open = async (path) => {
			const adapter = await open(path),
				allocate = adapter.transport.allocate;
			adapter.transport.allocate = async (input) => {
				const saved = JSON.parse(
					await readFile(join(directory, "build.json"), "utf8"),
				);
				assert.equal(saved.id, input.operationId);
				assert.equal(saved.state, "allocating");
				assert.equal(saved.admission.operatorLimitUsd, 0.2);
				calls.push(input);
				const host = await allocate(input);
				if (first) {
					first = false;
					throw Error("allocation acknowledgement lost");
				}
				return host;
			};
			return adapter;
		};
		const build = await builder.reconnect({ directory });
		await assert.rejects(
			build.start({ admitUsd: 0.2 }),
			(e) =>
				e.code === "ALLOCATION_UNCERTAIN" &&
				e.build.journal.admission.allowanceUsd === 0.2,
		);
		await assert.rejects(build.observe(), (e) => e.code === "INVALID_STATE");
		await assert.rejects(
			build.retire(),
			(e) => e.code === "ALLOCATION_UNCERTAIN",
		);
		await (await builder.reconnect({ directory })).start({ admitUsd: 0.2 });
		assert.deepEqual(calls[0], calls[1]);
		assert.equal(stats.launched, 1);
		assert.equal(stats.opened, stats.closed);
	}));

test("generated receipt identity reconnects by ID without opening a provider", () =>
	sourceFixture(async ({ base, root, config, licensesDirectory }) => {
		let opened = 0;
		const builder = createBuilder({
			receiptsDirectory: join(base, "receipts"),
			provider: {
				id: "fixture:offline",
				open: async () => {
					opened++;
					throw Error("must stay offline");
				},
			},
		});
		const build = await builder.prepare({ root, config, licensesDirectory });
		const same = await builder.reconnect({ id: build.id });
		assert.equal(same.id, build.id);
		assert.equal(same.directory, build.directory);
		assert.equal((await same.inspect()).work, "not-started");
		assert.equal(opened, 0);
	}));
