// Regras de cálculo da sala, usadas pela página para montar a tela.
// Estado Red: src/room.js ainda não existe, a importação falha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildView, staleUids, EXPIRY_MS, VOTE_OPTIONS } from '../src/room.js';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const ana = { name: 'Ana', email: 'ana@exemplo.com.br', role: 'DEV', joinedAt: T0 };
const bia = { name: 'Bia', email: 'bia@parceiro.exemplo.com.br', role: 'DEV', joinedAt: T0 };
const caio = { name: 'Caio', email: 'caio@exemplo.com.br', role: 'QA', joinedAt: T0 };
const duda = { name: 'Duda', email: 'duda@exemplo.com.br', role: 'ESPECTADOR', joinedAt: T0 };
const participants = { ana, bia, caio, duda };

test('o baralho é exatamente o combinado', () => {
  assert.deepEqual(VOTE_OPTIONS, [0, 0.5, 1, 1.5, 2, 3, 4, 5, 1000]);
});

test('antes de revelar a tela mostra quem votou, nunca o valor', () => {
  // Mesmo que um valor alheio chegue por engano, ele não aparece.
  const v = buildView({
    participants, voted: { ana: true, caio: true }, votes: { ana: 3, caio: 1.5 },
    revealed: false, myUid: 'bia', now: T0,
  });
  assert.deepEqual(v.panels.DEV.map((x) => [x.uid, x.voted]), [['ana', true], ['bia', false]]);
  assert.deepEqual(v.panels.QA.map((x) => [x.uid, x.voted]), [['caio', true]]);
  assert.doesNotMatch(JSON.stringify(v.panels), /"vote"/);
  assert.equal(v.stats.DEV, null);
  assert.deepEqual(v.spectators.map((s) => s.uid), ['duda']);
});

test('cada um vê a própria carta antes de revelar', () => {
  const v = buildView({
    participants, voted: { ana: true }, votes: { ana: 3 }, revealed: false, myUid: 'ana', now: T0,
  });
  assert.equal(v.me.vote, 3);
  assert.equal(v.me.role, 'DEV');
});

test('revelar mostra os votos e a média separada de DEV e QA', () => {
  const v = buildView({
    participants, voted: { ana: true, bia: true, caio: true },
    votes: { ana: 2, bia: 3, caio: 5 }, revealed: true, myUid: 'duda', now: T0,
  });
  assert.deepEqual(v.panels.DEV.map((x) => x.vote), [2, 3]);
  assert.deepEqual(v.stats.DEV, { average: 2.5, votes: 2, impossible: 0 });
  assert.deepEqual(v.stats.QA, { average: 5, votes: 1, impossible: 0 });
});

test('1000 (impossível de estimar) fica fora da média e é contado à parte', () => {
  const view = (votes) => buildView({
    participants, voted: { ana: true, bia: true }, votes, revealed: true, myUid: 'ana', now: T0,
  });
  assert.deepEqual(view({ ana: 1000, bia: 0.5 }).stats.DEV, { average: 0.5, votes: 2, impossible: 1 });
  assert.deepEqual(view({ ana: 1000, bia: 1000 }).stats.DEV, { average: null, votes: 2, impossible: 2 });
});

test('painel sem nenhum voto revelado não tem média', () => {
  const v = buildView({ participants, voted: {}, votes: {}, revealed: true, myUid: 'ana', now: T0 });
  assert.deepEqual(v.stats.QA, { average: null, votes: 0, impossible: 0 });
});

test('voto de espectador nunca entra na conta', () => {
  const v = buildView({
    participants, voted: { duda: true, ana: true }, votes: { duda: 5, ana: 1 },
    revealed: true, myUid: 'ana', now: T0,
  });
  assert.equal(v.stats.DEV.average, 1);
});

test('quem passou mais de 12h sem votar sai da tela e da média', () => {
  const ps = {
    ana: { ...ana, lastVoteAt: T0 },
    bia: { ...bia, lastVoteAt: T0 + 2 * HOUR },
    caio, // nunca votou, vale a hora em que entrou
  };
  assert.deepEqual(staleUids(ps, T0 + EXPIRY_MS), []);
  assert.deepEqual(staleUids(ps, T0 + EXPIRY_MS + 1).sort(), ['ana', 'caio']);

  const v = buildView({
    participants: ps, voted: { ana: true, bia: true }, votes: { ana: 5, bia: 3 },
    revealed: true, myUid: 'bia', now: T0 + EXPIRY_MS + 1,
  });
  assert.deepEqual(v.panels.DEV.map((x) => x.uid), ['bia']);
  assert.equal(v.panels.QA.length, 0);
  assert.equal(v.stats.DEV.average, 3);
});

test('entrar de novo renova o prazo', () => {
  const ps = { ana: { ...ana, lastVoteAt: T0, joinedAt: T0 + 20 * HOUR } };
  assert.deepEqual(staleUids(ps, T0 + 25 * HOUR), []);
});

test('quem não está na sala (ou expirou) não tem "me"', () => {
  const v = buildView({ participants, voted: {}, votes: {}, revealed: false, myUid: 'zeca', now: T0 });
  assert.equal(v.me, null);
});
