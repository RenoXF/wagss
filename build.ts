import { $ } from 'bun';
import tailwindPlugin from 'bun-plugin-tailwind';
import { mkdirSync, rmSync } from 'node:fs';
import { description, version } from 'package.json';

rmSync('./out', { recursive: true, force: true });
mkdirSync('./out', { recursive: true });

const allPlatforms: Record<string, Bun.CompileBuildOptions> = {
  windows: {
    target: 'bun-windows-x64',
    outfile: `wagss-windows-${version}.exe`,
    windows: {
      copyright: `© ${new Date().getFullYear()} Vermaysha`,
      description: description,
      title: 'WAGSS - Single-Account WhatsApp Gateway',
      version: version,
      icon: './assets/icon.ico',
    },
  },
  linux: { target: 'bun-linux-x64', outfile: `wagss-linux-${version}` },
  macos: { target: 'bun-darwin-arm64', outfile: `wagss-macos-${version}` },
  'linux-arm64': {
    target: 'bun-linux-arm64',
    outfile: `wagss-linux-arm64-musl-${version}`,
  },
};

// Get target platform from command line argument
const targetArg = Bun.argv[2];
const platforms: Bun.CompileBuildOptions[] =
  targetArg && allPlatforms[targetArg]
    ? [allPlatforms[targetArg]]
    : Object.values(allPlatforms);

const gitVersion = await $`git describe --tags --always`.text();
const buildTime = new Date().toISOString();
const gitCommit = await $`git rev-parse HEAD`.text();

for (const platform of platforms) {
  const startTime = Date.now();
  await Bun.build({
    entrypoints: ['./src/index.ts'],
    outdir: './out',
    compile: platform,
    minify: true,
    target: 'bun',
    env: 'inline',
    define: {
      BUILD_VERSION: JSON.stringify(gitVersion.trim()),
      APP_VERSION: JSON.stringify(version),
      BUILD_TIME: JSON.stringify(buildTime),
      GIT_COMMIT: JSON.stringify(gitCommit.trim()),
      'Bun.env.NODE_ENV': JSON.stringify('production'),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    plugins: [tailwindPlugin],
  });

  const endTime = Date.now();
  console.log(
    `Built for ${platform.target} in ${(endTime - startTime) / 1000} seconds.`,
  );
}
