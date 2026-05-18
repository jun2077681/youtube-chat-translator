import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const watch = process.argv.includes("--watch");
const outdir = resolve("dist");

const entryPoints = {
  background: "src/background/background.ts",
  content: "src/content/content.ts",
  "input-translator": "src/content/input-translator.ts",
  "channel-detector": "src/content/channel-detector.ts",
  popup: "src/popup/popup.ts",
};

const sharedOptions = {
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  logLevel: "info",
  sourcemap: true,
  legalComments: "none",
};

function copyStatic() {
  cpSync("manifest.json", resolve(outdir, "manifest.json"));
  if (existsSync("icons")) cpSync("icons", resolve(outdir, "icons"), { recursive: true });
  cpSync("src/popup/popup.html", resolve(outdir, "popup.html"));
  cpSync("src/content/content.css", resolve(outdir, "content.css"));
  console.log("[build] static assets copied");
}

async function run() {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const buildOptions = { ...sharedOptions, entryPoints, outdir };

  if (watch) {
    const ctx = await context({
      ...buildOptions,
      plugins: [
        {
          name: "copy-static-on-rebuild",
          setup(b) {
            b.onEnd(() => copyStatic());
          },
        },
      ],
    });
    await ctx.watch();
    copyStatic();
    console.log("[build] watching for changes…");
  } else {
    await build(buildOptions);
    copyStatic();
    console.log("[build] done");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
