// Regras de acesso do Realtime Database, rodando no emulador do Firebase.
// É aqui que mora o sigilo do voto e o filtro de domínio: o navegador não é confiável.
// Usa o modelo versionado com domínios de exemplo; os reais ficam fora do git.
// Rodar com: npm run test:rules
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { ref, get, set, update, remove } from 'firebase/database';
import { buildRules } from '../scripts/build-rules.mjs';

let env;
const HOUR = 60 * 60 * 1000;

const people = {
  ana: { email: 'ana@exemplo.com.br', role: 'DEV' },
  bia: { email: 'bia@parceiro.exemplo.com.br', role: 'DEV' },
  caio: { email: 'caio@exemplo.com.br', role: 'QA' },
  duda: { email: 'duda@exemplo.com.br', role: 'ESPECTADOR' },
};

function db(uid, email = people[uid]?.email, verified = true) {
  return env.authenticatedContext(uid, { email, email_verified: verified }).database();
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-estimativas',
    database: {
      rules: buildRules(
        readFileSync(new URL('../database.rules.template.json', import.meta.url), 'utf8'),
        ['exemplo.com.br', 'parceiro.exemplo.com.br', 'convidado@gmail.com'],
      ),
    },
  });
});

after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearDatabase();
  const now = Date.now();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.database();
    for (const [uid, p] of Object.entries(people)) {
      await set(ref(d, `participants/${uid}`), { name: uid, email: p.email, role: p.role, joinedAt: now });
    }
    await set(ref(d, 'room/revealed'), false);
    await set(ref(d, 'votes/ana'), 3);
    await set(ref(d, 'voted/ana'), true);
  });
});

test('quem não entrou não lê nada', async () => {
  const anon = env.unauthenticatedContext().database();
  await assertFails(get(ref(anon, 'participants')));
  await assertFails(get(ref(anon, 'room')));
});

test('e-mail de fora da lista não lê nem escreve', async () => {
  const x = db('x', 'x@gmail.com');
  await assertFails(get(ref(x, 'participants')));
  await assertFails(set(ref(x, 'participants/x'), { name: 'x', email: 'x@gmail.com', role: 'DEV', joinedAt: Date.now() }));
  await assertFails(get(ref(db('y', 'y@falsoexemplo.com.br'), 'participants')));
});

test('e-mail exato da lista entra, outro do mesmo provedor não', async () => {
  await assertSucceeds(get(ref(db('conv', 'convidado@gmail.com'), 'participants')));
  await assertFails(get(ref(db('outro', 'outro@gmail.com'), 'participants')));
});

test('e-mail da lista não confirmado não entra', async () => {
  await assertFails(get(ref(db('ana', 'ana@exemplo.com.br', false), 'participants')));
});

test('membros da lista leem a sala e quem votou', async () => {
  const bia = db('bia');
  await assertSucceeds(get(ref(bia, 'participants')));
  await assertSucceeds(get(ref(bia, 'voted')));
  await assertSucceeds(get(ref(bia, 'room')));
});

test('antes de revelar ninguém lê o voto do outro', async () => {
  const bia = db('bia');
  await assertFails(get(ref(bia, 'votes')));
  await assertFails(get(ref(bia, 'votes/ana')));
  await assertSucceeds(get(ref(db('ana'), 'votes/ana')));
});

test('depois de revelar todos leem todos os votos', async () => {
  await assertSucceeds(set(ref(db('duda'), 'room/revealed'), true));
  await assertSucceeds(get(ref(db('bia'), 'votes')));
  await assertSucceeds(get(ref(db('duda'), 'votes/ana')));
});

test('só vota quem é DEV ou QA, só no próprio nome e só com carta do baralho', async () => {
  await assertSucceeds(set(ref(db('bia'), 'votes/bia'), 1000));
  await assertSucceeds(set(ref(db('caio'), 'votes/caio'), 0.5));
  await assertFails(set(ref(db('bia'), 'votes/ana'), 5));
  await assertFails(set(ref(db('bia'), 'votes/bia'), 8));
  await assertFails(set(ref(db('bia'), 'votes/bia'), '3'));
  await assertFails(set(ref(db('duda'), 'votes/duda'), 1));
  await assertFails(set(ref(db('bia'), 'voted/ana'), true));
});

test('voto pode mudar depois de revelado', async () => {
  await set(ref(db('ana'), 'room/revealed'), true);
  await assertSucceeds(set(ref(db('ana'), 'votes/ana'), 5));
});

test('qualquer membro reinicia, mas ninguém escreve voto alheio pelo reinício', async () => {
  const bia = db('bia');
  await assertSucceeds(update(ref(bia), { votes: null, voted: null, 'room/revealed': false }));
  await assertFails(set(ref(bia, 'votes'), { ana: 5 }));
});

test('cada um só edita o próprio cadastro, com e-mail do login e papel válido', async () => {
  const bia = db('bia');
  const now = Date.now();
  await assertSucceeds(set(ref(bia, 'participants/bia'), { name: 'Bia', email: people.bia.email, role: 'QA', joinedAt: now }));
  await assertFails(set(ref(bia, 'participants/ana'), { name: 'Ana', email: people.ana.email, role: 'QA', joinedAt: now }));
  await assertFails(set(ref(bia, 'participants/bia'), { name: 'Bia', email: 'outra@exemplo.com.br', role: 'QA', joinedAt: now }));
  await assertFails(set(ref(bia, 'participants/bia'), { name: 'Bia', email: people.bia.email, role: 'PO', joinedAt: now }));
});

test('cadastro parado há mais de 12h pode ser limpo por qualquer membro, recente não', async () => {
  const old = Date.now() - 13 * HOUR;
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), 'participants/caio'), { name: 'caio', email: people.caio.email, role: 'QA', joinedAt: old, lastVoteAt: old });
  });
  await assertSucceeds(remove(ref(db('bia'), 'participants/caio')));
  await assertFails(remove(ref(db('bia'), 'participants/ana')));
});
