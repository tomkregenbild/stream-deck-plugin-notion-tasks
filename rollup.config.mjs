import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.tom-kregenbild.notion-tasks.sdPlugin";
const staticAssets = [
	{
		source: "layouts/notion-metrics.touch-layout.json",
		target: path.join(sdPlugin, "layouts", "notion-metrics.touch-layout.json"),
	},
	{
		source: "layouts/debug-simple.touch-layout.json",
		target: path.join(sdPlugin, "layouts", "debug-simple.touch-layout.json"),
	},
];

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url
				.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath))
				.href;
		},
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart() {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		{
			name: "copy-static-assets",
			async buildStart() {
				for (const asset of staticAssets) {
					this.addWatchFile(asset.source);
				}
			},
			async writeBundle() {
				for (const asset of staticAssets) {
					await fs.mkdir(path.dirname(asset.target), { recursive: true });
					await fs.copyFile(asset.source, asset.target);
				}
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined,
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			},
		},
	],
};

export default config;

