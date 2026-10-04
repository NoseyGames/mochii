import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

                                                                                    
                                                                               
export const staticFiles = Object.freeze([
  'index.html', 'math.html', 'history.html', 'flyflix.html',
  'flyflix-provider.html', 'proxy-host.html', 'style.css', 'sw.js', '_headers',
  'apps/auk.html', 'apps/auk.js', 'apps/auk.css', 'apps/vox.html',
  'apps/desktop.html', 'apps/desktop.js', 'apps/desktop.css',
  'apps/mochii-cloud.html', 'apps/mochii-cloud.css', 'apps/mochii-cloud.js', 'apps/mochii-cloud.data.js',
  'apps/mochii-inbox.js', 'apps/mochii-figure.js',
  'browser-tools/config.js', 'browser-tools/shell-entry.js', 'browser-tools/tools.js', 'browser-tools/tools.css',
  'browser-tools/runtime.js', 'browser-tools/remote-runtime.js',
  'browser-tools/proxy-network.js', 'browser-tools/proxy-host.js',
  'browser-tools/userscripts.js', 'browser-tools/privacy.js', 'browser-tools/ai-help.js',
  'ultrav/uv.bundle.js', 'ultrav/uv.client.js', 'ultrav/uv.handler.js',
  'ultrav/uv.sw.js', 'ultrav/uv.config.js',
]);

export const vendorFiles = Object.freeze([
  ['@mercuryworkshop/bare-mux', 'dist/index.js', 'bearmux/index.js'],
  ['@mercuryworkshop/bare-mux', 'dist/worker.js', 'bearmux/worker.js'],
  ['@mercuryworkshop/bare-mux', 'dist/index.js.map', 'bearmux/index.js.map'],
  ['@mercuryworkshop/bare-mux', 'dist/worker.js.map', 'bearmux/worker.js.map'],
  ['@mercuryworkshop/bare-mux', 'LICENSE', 'bearmux/LICENSE'],
  ['@mercuryworkshop/epoxy-transport', 'dist/index.mjs', 'bearmux/epoxy/index.mjs'],
]);

const notFound = '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Monkeh</title><body><h1>Page not found</h1><p>This address does not match a Monkeh page.</p><p><a href="/">Return to Monkeh</a></p></body></html>\n';

export async function buildStatic(rootDirectory = projectRoot) {
  const root = await realpath(resolve(rootDirectory));
  const output = join(root, 'dist');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const copies = staticFiles.map(path => [join(root, path), path]);

  for (const packageName of new Set(vendorFiles.map(([name]) => name))) {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
    const pinnedVersion = manifest.dependencies?.[packageName];
    if (!pinnedVersion || installed.version !== pinnedVersion) {
      throw new Error(`${packageName} must match its exact package.json version; run pnpm install --frozen-lockfile.`);
    }
  }
  for (const [packageName, source, destination] of vendorFiles) {
    copies.push([join(root, 'node_modules', packageName, source), destination]);
  }

                                                                       
  for (const [source] of copies) {
    if (!(await lstat(source)).isFile()) throw new Error(`Static asset is not a regular file: ${source}`);
  }

                                                                                
                                                                            
  const previous = await lstat(output).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous && (!previous.isDirectory() || previous.isSymbolicLink() || await realpath(output) !== output)) {
    throw new Error('Refusing to replace dist because it is not a regular project directory.');
  }
  if (dirname(output) !== root) throw new Error('Static output must stay inside the project root.');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [source, destination] of copies) {
    const target = join(output, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
                                                                              
  await writeFile(join(output, '404.html'), notFound);
  return { directory: output, files: copies.length + 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildStatic();
    console.log(`Static build ready: ${result.files} files in ${result.directory}`);
  } catch (error) {
    console.error(`Static build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
