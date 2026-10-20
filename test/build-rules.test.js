// Montagem das regras do banco a partir do modelo e da lista local de acesso.
// Estado Red do e-mail exato: emailRegex recusa entradas com @.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, emailRegex, parseAllowList } from '../scripts/build-rules.mjs';

test('a regex aceita só os domínios exatos da lista', () => {
  const re = new RegExp(emailRegex(['exemplo.com.br', 'parceiro.exemplo.com.br']).slice(1, -2), 'i');
  assert.ok(re.test('ana@exemplo.com.br'));
  assert.ok(re.test('Bia@Parceiro.Exemplo.com.br'));
  assert.ok(!re.test('x@falsoexemplo.com.br'));
  assert.ok(!re.test('x@exemplo.com.br.evil.com'));
  assert.ok(!re.test('x@outro.exemplo.com.br'));
  assert.ok(!re.test('x@exemploxcom.br'));
  assert.ok(!re.test('@exemplo.com.br'));
});

test('e-mail exato na lista libera só aquele e-mail', () => {
  const re = new RegExp(emailRegex(['exemplo.com.br', 'convidado@gmail.com']).slice(1, -2), 'i');
  assert.ok(re.test('convidado@gmail.com'));
  assert.ok(re.test('Convidado@Gmail.com'));
  assert.ok(re.test('ana@exemplo.com.br'));
  assert.ok(!re.test('outro@gmail.com'));
  assert.ok(!re.test('xconvidado@gmail.com'));
  assert.ok(!re.test('convidado@gmail.com.br'));
  assert.ok(!re.test('convidado@gmailxcom'));
  assert.ok(!re.test('convidado.x@gmail.com'));
});

test('e-mail exato inválido interrompe a montagem', () => {
  assert.throws(() => emailRegex(['a b@gmail.com']));
  assert.throws(() => emailRegex(['a@*.com']));
  assert.throws(() => emailRegex(['.*@gmail.com']));
});

test('a lista ignora linhas vazias e comentários', () => {
  assert.deepEqual(parseAllowList('# lista\nexemplo.com.br\n\n  parceiro.exemplo.com.br  \n'),
    ['exemplo.com.br', 'parceiro.exemplo.com.br']);
});

test('domínio inválido ou lista vazia interrompe a montagem', () => {
  assert.throws(() => buildRules('{}', []));
  assert.throws(() => emailRegex(['exemplo.com.br|.*']));
  assert.throws(() => emailRegex(['*.exemplo.com.br']));
});

test('as regras montadas não sobram com marcador e trazem os domínios', () => {
  const rules = buildRules('{"a": "x.matches(__EMAIL_REGEX__)", "b": "__EMAIL_REGEX__"}', ['exemplo.com.br']);
  assert.doesNotMatch(rules, /__EMAIL_REGEX__/);
  assert.match(rules, /exemplo\[\.\]com\[\.\]br/);
  JSON.parse(rules);
});

test('o modelo versionado não contém nenhum domínio real', async () => {
  const { readFile } = await import('node:fs/promises');
  const template = await readFile(new URL('../database.rules.template.json', import.meta.url), 'utf8');
  assert.match(template, /__EMAIL_REGEX__/);
  assert.doesNotMatch(template, /@|\.com|\[\.\]/);
});
