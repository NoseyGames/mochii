import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatic, staticFiles, vendorFiles } from '../scripts/build-static.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'monkeh-static-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new Set([...staticFiles, 'package.json']);
  for (const [name, source] of vendorFiles) {
    files.add(`node_modules/${name}/${source}`);
    files.add(`node_modules/${name}/package.json`);
  }
  for (const file of files) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await copyFile(join(root, file), join(directory, file));
  }
  return directory;
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, path));
    else files.push(path);
  }
  return files.sort();
}

test('static build includes browser assets and pinned bundles without backend files or secrets', async t => {
  const directory = await fixture(t);
  for (const privateFile of ['.env', 'server.mjs', 'unlisted.js', 'README.md']) {
    await writeFile(join(directory, privateFile), 'must not be published');
  }
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'dist', 'stale-secret.txt'), 'must not survive a rebuild');
  const result = await buildStatic(directory);
  const expected = [...staticFiles, ...vendorFiles.map(([, , output]) => output), '404.html'].sort();
  assert.deepEqual(await listFiles(result.directory), expected);
  assert.equal(result.files, expected.length);
  for (const [packageName, source, destination] of vendorFiles) {
    assert.deepEqual(await readFile(join(result.directory, destination)), await readFile(join(directory, 'node_modules', packageName, source)));
  }
  assert.match(await readFile(join(result.directory, '404.html'), 'utf8'), /Page not found/);
});

test('static build rejects mismatched vendor versions before replacing previous output', async t => {
  const directory = await fixture(t);
  const packagePath = join(directory, 'node_modules/@mercuryworkshop/bare-mux/package.json');
  await writeFile(packagePath, JSON.stringify({ version: '0.0.0' }));
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'dist', 'previous.txt'), 'previous successful build');
  await assert.rejects(buildStatic(directory), /must match its exact package.json version/);
  assert.equal(await readFile(join(directory, 'dist', 'previous.txt'), 'utf8'), 'previous successful build');
});

test('static build refuses a file in place of its output directory', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'dist'), 'user file');
  await assert.rejects(buildStatic(directory), /not a regular project directory/);
  assert.equal(await readFile(join(directory, 'dist'), 'utf8'), 'user file');
});
