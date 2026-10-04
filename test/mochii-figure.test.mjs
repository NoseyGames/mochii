import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../apps/mochii-cloud.data.js';
import { getFigureLaunchUrl } from '../apps/mochii-figure.js';

test('verified Figure links translate local IDs into provider keys without changing the hosted origin or launch contract', () => {
  const mapped = GAMES.map(game => ({ game, href: getFigureLaunchUrl(game.id) })).filter(item => item.href !== null);
  assert.equal(mapped.length, 94);
  const keys = new Set();
  for (const { game, href } of mapped) {
    const url = new URL(href);
    assert.equal(url.origin, 'https://figure-cloud.figure-softwares.workers.dev', game.id);
    assert.equal(url.pathname, '/');
    assert.equal(url.username + url.password + url.hash + url.port, '');
    assert.deepEqual([...url.searchParams.keys()], ['game']);
    const key = url.searchParams.get('game');
    assert.match(key, /^[A-Za-z0-9]+$/);
    assert.notEqual(key, game.id);
    assert(!keys.has(key), `Duplicate provider mapping: ${game.id}`);
    keys.add(key);
  }
});

test('known title matches retain the exact Figure key including case', () => {
  assert.equal(getFigureLaunchUrl('117'), 'https://figure-cloud.figure-softwares.workers.dev/?game=jy0354');
  assert.equal(getFigureLaunchUrl('209'), 'https://figure-cloud.figure-softwares.workers.dev/?game=jy0108');
  assert.equal(getFigureLaunchUrl('598'), 'https://figure-cloud.figure-softwares.workers.dev/?game=dg0170');
  assert.equal(getFigureLaunchUrl('610'), 'https://figure-cloud.figure-softwares.workers.dev/?game=KJ0019');
});

test('unmapped local games and unknown IDs never receive a guessed Figure launch', () => {
  const unmatched = GAMES.filter(game => getFigureLaunchUrl(game.id) === null);
  assert.equal(unmatched.length, 12);
  for (const game of unmatched) assert.equal(getFigureLaunchUrl(game.id), null);
  for (const value of ['', '0', '999999', '017', '0117', '117 ', ' 117', 'jy0354', '__proto__', 'constructor', 'toString',
    'https://evil.example/', '//evil.example/', '117&token=forged', '117?embed=1', '../api/auto-signup', '117\n']) {
    assert.equal(getFigureLaunchUrl(value), null);
  }
});

test('Figure lookup rejects nonstrings without coercing attacker-controlled values', () => {
  const throwing = { toString() { throw new Error('Must not coerce'); }, valueOf() { throw new Error('Must not coerce'); } };
  for (const value of [undefined, null, false, true, 117, 117n, NaN, Symbol('117'), ['117'], new String('117'), throwing]) {
    assert.equal(getFigureLaunchUrl(value), null);
  }
});
