import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), "android-builder-package-"));
const run = async (name, args, cwd) => {
	try {
		return await exec(name, args, {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
			env: {
				...process.env,
				npm_config_cache: join(base, "cache"),
				npm_config_update_notifier: "false",
			},
		});
	} catch (error) {
		console.error(error.stdout, error.stderr);
		throw error;
	}
};
console.log(`Package verification directory: ${base}`);
await run("npm", ["run", "build"], process.cwd());
const packed = JSON.parse(
	(
		await run(
			"npm",
			["pack", "--ignore-scripts", "--json", "--pack-destination", base],
			process.cwd(),
		)
	).stdout,
)[0];
const files = packed.files.map((v) => v.path);
for (const path of [
	"dist/index.js",
	"dist/index.d.ts",
	"dist/builder.d.ts",
	"dist/diagnostics.d.ts",
	"dist/results.d.ts",
	"dist/artifacts.d.ts",
	"dist/cli.js",
	"dist/providers/boat.js",
	"host/host.py",
	"host/build.sh",
	"examples/expo/App.tsx",
	"examples/gradle/gradlew",
	"docs/ci.md",
	"docs/install.md",
	"docs/sdk.md",
	"docs/expo.md",
	"docs/automation.md",
	"maintainer/README.md",
	"LICENSE",
])
	assert.ok(files.includes(path), path);
assert.ok(
	!files.some((p) =>
		/(?:^|\/)(?:node_modules|tests|\.git|\.env|\.android-builds|goals)(?:\/|$)/.test(
			p,
		),
	),
	"private/development paths absent",
);
await writeFile(
	join(base, "pack-inventory.json"),
	JSON.stringify(packed, null, 2),
);
const tarball = join(base, packed.filename);
const sdk = join(base, "sdk");
await mkdir(sdk);
await writeFile(
	join(sdk, "package.json"),
	JSON.stringify({ private: true, type: "module" }),
);
await run(
	"npm",
	[
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		tarball,
		"typescript@6.0.3",
		"@types/node@26.6.3",
	],
	sdk,
);
await run(
	process.execPath,
	[
		resolve("scripts/check-doc-links.mjs"),
		join(sdk, "node_modules/@firtoz/android-builder"),
	],
	sdk,
);
await writeFile(
	join(sdk, "smoke.mjs"),
	`import {createBuilder,defineProjectConfig,BuildError} from '@firtoz/android-builder';
import {boatProvider,boatTransport} from '@firtoz/android-builder/providers/boat';
if(typeof createBuilder!=='function'||typeof defineProjectConfig!=='function'||!BuildError)throw Error('SDK exports');
if(boatProvider().id!=='boat:large')throw Error('factory identity');
const adapter=boatTransport('.', 'offline-fixture-token');adapter.close();
`,
);
await run(process.execPath, ["smoke.mjs"], sdk);
assert.match(
	(
		await run(
			process.execPath,
			[join(sdk, "node_modules/@firtoz/android-builder/dist/cli.js"), "--help"],
			sdk,
		)
	).stdout,
	/observe/,
);
assert.match(
	(await run(join(sdk, "node_modules/.bin/android-builder"), ["--help"], sdk))
		.stdout,
	/observe/,
);
await writeFile(
	join(sdk, "consumer.ts"),
	`import {createBuilder,defineProjectConfig,BuildOperationError,type BuildHandle,type BuildProvider} from '@firtoz/android-builder';
const config=defineProjectConfig({project:{kind:'gradle'},admissionAllowanceUsd:0.2});
const builder=createBuilder();
async function use(build:BuildHandle){try{await build.start({admitUsd:0.2,waitForCompletion:false});await builder.list({limit:20});const result=await build.wait({signal:new AbortController().signal});if(result.outcome==='succeeded'){const hash:string=result.artifact.sha256;const seconds:number|undefined=result.timings[0]?.seconds;void hash;void seconds;}const artifact=await build.exportArtifact('/approved/build.apk');const bytes:number=artifact.bytes;void bytes;return build.artifact()}catch(e){if(e instanceof BuildOperationError)console.log(e.code,e.build.cleanup);throw e}}
void config; void builder; void use; const provider:BuildProvider={id:'fixture',open:async()=>{throw Error('not allocated')}};void provider;
`,
);
const strict = [
	"--noEmit",
	"--strict",
	"--module",
	"NodeNext",
	"--moduleResolution",
	"NodeNext",
	"--target",
	"ES2023",
	"--lib",
	"ES2023",
	"--types",
	"node",
	"--skipLibCheck",
	"false",
];
await run(
	process.execPath,
	[join(sdk, "node_modules/typescript/bin/tsc"), ...strict, "consumer.ts"],
	sdk,
);
const licenses = join(base, "fixture-licenses");
await mkdir(licenses);
await writeFile(join(licenses, "android-sdk-license"), "a".repeat(40));
for (const kind of ["gradle", "expo"]) {
	const app = join(base, kind);
	await cp(resolve("examples", kind), app, { recursive: true });
	await writeFile(join(app, ".gitignore"), "node_modules/\n");
	await mkdir(join(app, "vendor"));
	const localTarball = join(app, "vendor", packed.filename);
	await cp(tarball, localTarball);
	await run(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--save-dev",
			localTarball,
			"typescript@6.0.3",
			"@types/node@26.6.3",
			...(kind === "expo" ? ["@types/react@19.2.2"] : []),
		],
		app,
	);
	await run("npm", ["run", "typecheck"], app);
	await run("git", ["init", "-q"], app);
	await run("git", ["add", "."], app);
	await run(
		"git",
		[
			"-c",
			"user.name=Package Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-qm",
			"Generic package verification fixture",
		],
		app,
	);
	const cli = join(app, "node_modules/@firtoz/android-builder/dist/cli.js"),
		receipt = join(base, `${kind}-receipt`);
	const prepared = JSON.parse(
		(
			await run(
				process.execPath,
				[
					cli,
					"prepare",
					"--root",
					app,
					"--config",
					join(app, "android-builder.config.ts"),
					"--licenses",
					licenses,
					"--directory",
					receipt,
					"--json",
				],
				app,
			)
		).stdout,
	);
	assert.equal(prepared.ok, true);
	assert.equal(prepared.build.work, "not-started");
	assert.equal(prepared.build.cleanup, "not-allocated");
	const inspected = JSON.parse(
		(
			await run(
				process.execPath,
				[cli, "inspect", "--directory", receipt, "--json"],
				app,
			)
		).stdout,
	);
	assert.equal(inspected.build.id, prepared.build.id);
	console.log(
		`${kind}: fresh install, strict types, frozen preparation and offline JSON inspection passed`,
	);
}
await writeFile(
	join(base, "verification.json"),
	JSON.stringify(
		{
			tarball,
			files: files.length,
			bytes: packed.size,
			sha512: packed.integrity,
			checks: [
				"fresh SDK install/import/SQLite",
				"strict public API",
				"CLI help",
				"both fresh example installs",
				"strict native config and Expo config/TSX",
				"both source preflights/JSON offline inspection",
			],
			boundary: "No remote allocation or Android compilation",
		},
		null,
		2,
	),
);
console.log(
	`Verified ${packed.filename}: ${files.length} files, ${packed.size} bytes. No cloud operations. Evidence: ${join(base, "verification.json")}`,
);
