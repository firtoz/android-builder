import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { buildJournal, sha256 } from "../dist/contracts.js";
import { exec, saveJournal, withBuildLock } from "../dist/files.js";
import {
	BuildError,
	createBuilder,
	defineProjectConfig,
	listBuilds,
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
	const stats = {
		opened: 0,
		closed: 0,
		allocated: 0,
		launched: 0,
		retired: 0,
		observed: 0,
		downloaded: 0,
	};
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
						if (cmd.includes(" observe ")) {
							stats.observed++;
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
						}
						return "";
					},
					download: async (_h, _p, _b, target) => {
						stats.downloaded++;
						await writeFile(target, flags.corrupt ? "corrupt" : apk);
					},
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
			try {
				await exec(
					process.execPath,
					[
						cli,
						"wait",
						"--directory",
						directory,
						"--provider-module",
						modulePath,
						"--json",
					],
					{ env: { ...process.env, [`FIXTURE_${mode}_FAIL`]: "1" } },
				);
				assert.fail("non-successful completion must fail CI");
			} catch (e) {
				assert.equal(e.code, 1);
				const completion = JSON.parse(e.stdout);
				assert.equal(completion.ok, false);
				assert.equal(
					completion.result.outcome,
					mode === "BUILD" ? "failed" : "needs-attention",
				);
				assert.ok(
					completion.result.issues.some(
						(i) =>
							i.code ===
							(mode === "BUILD" ? "BUILD_FAILED" : "RETIREMENT_UNCONFIRMED"),
					),
				);
				assert.equal(completion.result.journal, undefined);
				assert.equal(completion.build, undefined);
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

test("async start acknowledges launch without observation or cleanup, then reconnect retrieves once", () =>
	handleFixture(async ({ directory, builder, stats }) => {
		const build = await builder.reconnect({ directory });
		const started = await build.start({
			admitUsd: 0.2,
			waitForCompletion: false,
		});
		assert.equal(started.work, "running");
		assert.equal(started.cleanup, "unresolved");
		assert.equal(started.artifact, undefined);
		assert.equal(stats.observed, 0);
		assert.equal(stats.downloaded, 0);
		assert.equal(stats.retired, 0);
		assert.equal(stats.opened, stats.closed);
		await assert.rejects(
			readFile(join(directory, "controller.lock/owner.json")),
			{ code: "ENOENT" },
		);
		await build.start({ admitUsd: 0.2, waitForCompletion: false });
		assert.equal(stats.allocated, 1);
		assert.equal(stats.launched, 1);
		assert.equal(stats.observed, 0);
		const same = await builder.reconnect({ directory }),
			result = await same.observe();
		assert.equal(result.id, started.id);
		assert.equal(result.journal.expiresAt, started.journal.expiresAt);
		assert.equal(result.journal.artifactVerified, true);
		assert.equal(result.cleanup, "retired");
		assert.equal(stats.downloaded, 1);
		assert.equal(stats.retired, 1);
		assert.equal(stats.allocated, 1);
		assert.equal(stats.launched, 1);
		assert.equal(stats.opened, stats.closed);
	}));

test("async start never replays an uncertain launch or hides a subsequent compiler failure", () =>
	handleFixture(async ({ directory, builder, stats, flags }) => {
		const build = await builder.reconnect({ directory });
		flags.lostAck = true;
		await assert.rejects(
			build.start({ admitUsd: 0.2, waitForCompletion: false }),
			(e) => e.code === "LAUNCH_UNCERTAIN",
		);
		await assert.rejects(
			build.start({ admitUsd: 0.2, waitForCompletion: false }),
			(e) => e.code === "LAUNCH_UNCERTAIN",
		);
		assert.equal(stats.launched, 1);
		assert.equal(stats.allocated, 1);
		assert.equal(stats.observed, 0);
		flags.fail = true;
		await assert.rejects(
			build.observe(),
			(e) =>
				e.code === "BUILD_FAILED" &&
				e.build.work === "failed" &&
				e.build.cleanup === "retired",
		);
		await assert.rejects(
			build.start({ admitUsd: 0.2, waitForCompletion: false }),
			(e) => e.code === "BUILD_FAILED",
		);
		assert.equal(stats.launched, 1);
		assert.equal(stats.allocated, 1);
		assert.equal(stats.opened, stats.closed);
	}));

test("offline history orders and bounds direct receipts, reports unreadable entries, and preserves state", () =>
	handleFixture(async ({ directory, journal }) => {
		for (const [name, preparedAt, state, retired, artifactVerified] of [
			["older", 100, "failed", true, false],
			["newer", 200, "complete", false, true],
		]) {
			const child = join(directory, name);
			await mkdir(child);
			await saveJournal(child, {
				...journal,
				id: randomUUID(),
				preparedAt,
				state,
				retired,
				artifactVerified,
			});
		}
		await mkdir(join(directory, "broken"));
		await writeFile(join(directory, "broken/build.json"), "{");
		const before = await readFile(join(directory, "newer/build.json"), "utf8");
		const builder = createBuilder({
			receiptsDirectory: directory,
			provider: {
				id: "fixture:never-open",
				open: async () => {
					throw Error("history must stay offline");
				},
			},
		});
		const history = await builder.list({ limit: 1 });
		assert.equal(history.builds.length, 1);
		assert.equal(history.total, 2);
		assert.equal(history.builds[0].preparedAt, 200);
		assert.equal(history.builds[0].work, "complete");
		assert.equal(history.builds[0].cleanup, "unresolved");
		assert.equal(history.builds[0].artifactVerified, true);
		assert.equal(history.issues.length, 1);
		assert.equal(history.issues[0].code, "RECEIPT_UNAVAILABLE");
		assert.equal(
			await readFile(join(directory, "newer/build.json"), "utf8"),
			before,
		);
		assert.equal((await listBuilds(directory)).builds[1].work, "failed");
		await assert.rejects(
			builder.list({ limit: 101 }),
			(e) => e.code === "INVALID_INPUT",
		);
		assert.equal((await listBuilds(join(directory, "missing"))).total, 0);
	}));

test("CLI async start and local build history reconnect to the same verified artifact", () =>
	sourceFixture(async ({ root, config, licensesDirectory, base }) => {
		const modulePath = join(base, "async-provider.mjs"),
			configPath = join(base, "config.json"),
			receipts = join(base, "receipts");
		await writeFile(configPath, JSON.stringify(config));
		await writeFile(
			modulePath,
			`import {appendFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; import {createHash} from 'node:crypto';
const apk=Buffer.from('simulated artifact, not an Android compile');
export const provider={id:'fixture:async',open:async(directory)=>({close:()=>{},transport:{allocate:async()=> 'owned_fixture',ready:async()=>{},upload:async()=>{},command:async(_h,text)=>{await appendFile(join(directory,'calls.log'),text+'\\n'); return text.includes(' observe ')?JSON.stringify({cursor:0,log:'',claimed:true,status:{state:'complete',phase:'compile',artifact:{bytes:apk.length,sha256:createHash('sha256').update(apk).digest('hex')}}}):''},download:async(_h,_p,_n,target)=>writeFile(target,apk),retire:async()=>{}}})};`,
		);
		const invoke = async (args) =>
			JSON.parse(
				(await exec(process.execPath, [cli, ...args, "--json"])).stdout,
			);
		const prepared = await invoke([
			"prepare",
			"--root",
			root,
			"--config",
			configPath,
			"--licenses",
			licensesDirectory,
			"--receipts-directory",
			receipts,
			"--provider-module",
			modulePath,
		]);
		const directory = prepared.build.directory;
		const started = await invoke([
			"start",
			"--directory",
			directory,
			"--admit-usd",
			"0.20",
			"--no-wait",
			"--provider-module",
			modulePath,
		]);
		assert.equal(started.ok, true);
		assert.equal(started.build.work, "running");
		assert.equal(started.build.journal.artifactVerified, false);
		const history = await invoke([
			"list",
			"--receipts-directory",
			receipts,
			"--limit",
			"1",
		]);
		assert.equal(history.history.builds[0].id, prepared.build.id);
		assert.equal(history.history.builds[0].work, "running");
		const result = await invoke([
			"observe",
			"--directory",
			directory,
			"--provider-module",
			modulePath,
		]);
		assert.equal(result.build.id, prepared.build.id);
		assert.equal(result.build.cleanup, "retired");
		assert.equal(result.build.journal.artifactVerified, true);
		const waited = await invoke(["wait", "--directory", directory]);
		assert.equal(waited.result.outcome, "succeeded");
		assert.equal(waited.result.artifact.buildId, prepared.build.id);
		assert.equal(waited.result.journal, undefined);
		assert.equal(waited.result.preparation, undefined);
		const output = join(base, "approved", `${prepared.build.id}.apk`);
		const exported = await invoke([
			"export",
			"--directory",
			directory,
			"--output",
			output,
		]);
		assert.equal(exported.artifact.sha256, waited.result.artifact.sha256);
		assert.equal(exported.artifact.path, output);
		await invoke(["export", "--directory", directory, "--output", output]);
		await writeFile(output, "different existing file");
		try {
			await invoke(["export", "--directory", directory, "--output", output]);
			assert.fail("must refuse conflicting output");
		} catch (e) {
			const failure = JSON.parse(e.stdout);
			assert.equal(failure.error.code, "ARTIFACT_EXPORT_CONFLICT");
			assert.equal(failure.recovery.buildId, prepared.build.id);
			assert.equal(failure.build, undefined);
		}
		const calls = await readFile(join(directory, "calls.log"), "utf8");
		assert.equal(
			calls.split("\n").filter((v) => v.endsWith(" launch")).length,
			1,
		);
		try {
			await invoke(["observe", "--directory", directory, "--no-wait"]);
			assert.fail("flag must be start-only");
		} catch (e) {
			assert.equal(e.code, 2);
			assert.equal(JSON.parse(e.stdout).error.code, "INVALID_INPUT");
		}
	}));

test("wait returns compact completion, preserves failed work and unresolved cleanup, and never starts prepared work", () =>
	handleFixture(async ({ directory, builder, flags, stats }) => {
		const build = await builder.reconnect({ directory });
		const prepared = await build.wait();
		assert.equal(prepared.outcome, "needs-attention");
		assert.equal(prepared.issues[0].code, "INVALID_STATE");
		assert.equal(stats.allocated, 0);
		await build.start({ admitUsd: 0.2, waitForCompletion: false });
		flags.fail = true;
		flags.cleanup = true;
		const failed = await build.wait();
		assert.equal(failed.outcome, "failed");
		assert.equal(failed.work, "failed");
		assert.equal(failed.cleanup, "unresolved");
		assert.equal(failed.artifact, undefined);
		assert.ok(failed.issues.some((i) => i.code === "BUILD_FAILED"));
		assert.ok(failed.issues.some((i) => i.code === "RETIREMENT_UNCONFIRMED"));
		assert.equal(failed.journal, undefined);
		assert.equal(failed.preparation, undefined);
		assert.equal(failed.applicationId, "org.example.hello");
		flags.cleanup = false;
		await build.retire();
		const opened = stats.opened,
			offline = await createBuilder().reconnect({ directory });
		assert.equal((await offline.wait()).outcome, "failed");
		assert.equal(stats.opened, opened);
		assert.equal(stats.launched, 1);
	}));

test("wait exposes a valid artifact independently from unconfirmed retirement and resolves cleanup without another compile", () =>
	handleFixture(async ({ directory, builder, flags, stats }) => {
		const build = await builder.reconnect({ directory });
		await build.start({ admitUsd: 0.2, waitForCompletion: false });
		flags.cleanup = true;
		const pending = await build.wait();
		assert.equal(pending.outcome, "needs-attention");
		assert.equal(pending.work, "complete");
		assert.equal(pending.cleanup, "unresolved");
		assert.ok(pending.artifact?.sha256);
		assert.deepEqual(pending.timings, []);
		assert.equal(pending.artifact.buildId, build.id);
		assert.equal(
			pending.artifact.bytes,
			(await readFile(pending.artifact.path)).length,
		);
		flags.cleanup = false;
		const complete = await build.wait();
		assert.equal(complete.outcome, "succeeded");
		assert.equal(complete.cleanup, "retired");
		assert.deepEqual(complete.issues, []);
		const opened = stats.opened;
		const offline = await createBuilder().reconnect({ directory });
		assert.equal((await offline.wait()).outcome, "succeeded");
		assert.equal(stats.opened, opened);
		assert.equal(stats.launched, 1);
	}));

test("wait does not publish corrupt transfer metadata and retries only the original artifact", () =>
	handleFixture(async ({ directory, builder, flags, stats }) => {
		const build = await builder.reconnect({ directory });
		await build.start({ admitUsd: 0.2, waitForCompletion: false });
		flags.corrupt = true;
		const bad = await build.wait();
		assert.equal(bad.outcome, "needs-attention");
		assert.equal(bad.artifact, undefined);
		assert.ok(
			bad.issues.some((i) => i.code === "ARTIFACT_VERIFICATION_FAILED"),
		);
		assert.equal(stats.retired, 0);
		flags.corrupt = false;
		assert.equal((await build.wait()).outcome, "succeeded");
		assert.equal(stats.downloaded, 2);
		assert.equal(stats.launched, 1);
		assert.equal(stats.allocated, 1);
	}));

test("verified export is local, idempotent, private and non-overwriting even with cleanup unresolved", () =>
	handleFixture(async ({ directory, builder, flags, stats }) => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "builder-export-"));
		try {
			const build = await builder.reconnect({ directory });
			await build.start({ admitUsd: 0.2, waitForCompletion: false });
			flags.cleanup = true;
			const result = await build.wait();
			const opened = stats.opened;
			const offline = await createBuilder().reconnect({ directory }),
				target = join(outputDirectory, "approved", `${build.id}.apk`);
			const exported = await offline.exportArtifact(target);
			assert.equal(exported.sha256, result.artifact.sha256);
			assert.equal(exported.sourceHash, result.source.hash);
			assert.equal(exported.buildId, build.id);
			assert.equal(exported.applicationId, result.applicationId);
			assert.equal(exported.path, target);
			const info = await stat(target);
			assert.equal(info.mode & 0o777, 0o600);
			assert.deepEqual(await offline.exportArtifact(target), exported);
			assert.equal((await stat(target)).ino, info.ino);
			assert.equal(stats.opened, opened);
			const journal = await readFile(join(directory, "build.json"));
			await assert.rejects(
				offline.exportArtifact(join(directory, "build.json")),
				(e) => e.code === "INVALID_INPUT",
			);
			assert.deepEqual(await readFile(join(directory, "build.json")), journal);
			await writeFile(target, "do not overwrite");
			await assert.rejects(
				offline.exportArtifact(target),
				(e) => e.code === "ARTIFACT_EXPORT_CONFLICT",
			);
			assert.equal(await readFile(target, "utf8"), "do not overwrite");
			await withBuildLock(directory, async () => {
				await assert.rejects(
					offline.exportArtifact(target),
					(e) => e.code === "LOCKED",
				);
			});
			assert.equal(stats.launched, 1);
			assert.equal(stats.opened, opened);
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	}));

test("export rejects changed source and symlinks without publishing partial output", () =>
	handleFixture(async ({ directory, builder }) => {
		const output = await mkdtemp(join(tmpdir(), "builder-export-integrity-"));
		try {
			const build = await builder.reconnect({ directory });
			await build.start({ admitUsd: 0.2 });
			const source = join(directory, "artifact.apk"),
				original = await readFile(source),
				target = join(output, "artifact.apk");
			await writeFile(source, Buffer.alloc(original.length, 0));
			await assert.rejects(
				build.exportArtifact(target),
				(e) => e.code === "ARTIFACT_VERIFICATION_FAILED",
			);
			assert.deepEqual(await readdir(output), []);
			await writeFile(source, original);
			await writeFile(join(output, "original.apk"), original);
			await symlink(join(output, "original.apk"), target);
			await assert.rejects(
				build.exportArtifact(target),
				(e) => e.code === "ARTIFACT_EXPORT_CONFLICT",
			);
			assert.deepEqual(await readFile(join(output, "original.apk")), original);
			await rm(target);
			await rm(source);
			await symlink(join(output, "original.apk"), source);
			await assert.rejects(
				build.exportArtifact(target),
				(e) => e.code === "ARTIFACT_VERIFICATION_FAILED",
			);
			await assert.rejects(
				build.artifact(),
				(e) => e.code === "ARTIFACT_VERIFICATION_FAILED",
			);
			await assert.rejects(readFile(target), { code: "ENOENT" });
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	}));
