// Ponta a ponta no navegador, contra os emuladores de banco e de login.
// Rodar com: npm run test:e2e
// Login por e-mail e senha, sem confirmação do e-mail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';
import { buildRules } from '../scripts/build-rules.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = 'demo-estimativas';
const PORT = 8081;
const APP = `http://localhost:${PORT}/?emulador`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

let server;
let browser;

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(PORT);

  const rules = buildRules(
    await readFile(join(ROOT, 'database.rules.template.json'), 'utf8'),
    ['exemplo.com.br', 'parceiro.exemplo.com.br'],
  );
  const put = await fetch(`http://localhost:9000/.settings/rules.json?ns=${PROJECT}-default-rtdb`, {
    method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules,
  });
  assert.equal(put.status, 200, 'regras carregadas no emulador');

  browser = await firefox.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(APP);
  await page.waitForSelector('#screen-login:not([hidden])');
  return page;
}

const PASSWORD = 'senha-de-teste-1';
const EMULATOR_AUTH = 'http://localhost:9099';

async function oobCode(email, type) {
  const res = await fetch(`${EMULATOR_AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`);
  const { oobCodes } = await res.json();
  const code = oobCodes.filter((c) => c.email === email && c.requestType === type).at(-1);
  assert.ok(code, `e-mail ${type} enviado para ${email}`);
  return code;
}

async function fillLogin(page, email, password = PASSWORD) {
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
}

async function signUp(page, email) {
  await fillLogin(page, email);
  await page.click('#signup');
}

async function enter(email, name, role) {
  const page = await newPage();
  await signUp(page, email);
  await page.waitForSelector('#screen-profile:not([hidden])');
  await page.fill('#profile-name', name);
  await page.check(`input[name=role][value=${role}]`);
  await page.click('#profile-form button[type=submit]');
  await page.waitForSelector('#screen-board:not([hidden])');
  return page;
}

const text = (p, sel) => p.locator(sel).innerText();
const card = (p, label) => p.getByRole('button', {
  name: label === 'impossível' ? 'Votar 1000, impossível de estimar' : `Votar ${label}`, exact: true,
});

test('a tela de login pede e-mail e senha, sem Google', async () => {
  const page = await newPage();
  assert.equal(await page.locator('#login-email').isVisible(), true);
  assert.equal(await page.locator('#login-password').isVisible(), true);
  assert.equal(await page.locator('#login-google').count(), 0);
  await page.context().close();
});

test('criar conta entra direto, sem confirmar o e-mail', async () => {
  const page = await newPage();
  await signUp(page, 'nova@exemplo.com.br');
  await page.waitForSelector('#screen-profile:not([hidden])');
  await page.context().close();
});

test('quem já tem conta entra só com e-mail e senha', async () => {
  const first = await enter('volta@exemplo.com.br', 'Volta', 'DEV');
  await first.click('#logout');
  await first.waitForSelector('#screen-login:not([hidden])');
  await fillLogin(first, 'volta@exemplo.com.br');
  await first.click('#login-form button[type=submit]');
  await first.waitForSelector('#screen-board:not([hidden])');
  await first.context().close();
});

test('senha errada avisa sem dizer se o e-mail existe', async () => {
  const page = await newPage();
  await fillLogin(page, 'volta@exemplo.com.br', 'senha-errada');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await text(page, '#error'), /E-mail ou senha incorretos/);
  await page.context().close();
});

test('criar conta com e-mail que já tem conta orienta a entrar', async () => {
  const page = await newPage();
  await fillLogin(page, 'volta@exemplo.com.br');
  await page.click('#signup');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await text(page, '#error'), /já tem conta/);
  await page.context().close();
});

test('esqueci minha senha envia o link de troca', async () => {
  const page = await newPage();
  await page.fill('#login-email', 'volta@exemplo.com.br');
  await page.click('#forgot');
  await page.waitForSelector('#notice:not([hidden])');
  assert.match(await text(page, '#notice'), /nova senha/);
  await oobCode('volta@exemplo.com.br', 'PASSWORD_RESET');
  await page.context().close();
});

test('e-mail fora da lista cria conta mas é barrado pelo servidor', async () => {
  const page = await newPage();
  await signUp(page, 'intruso@gmail.com');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await text(page, '#error'), /não tem acesso/);
  assert.equal(await page.locator('#screen-board').isHidden(), true);
  await page.context().close();
});

test('votação completa: ocultar, revelar, mudar voto, reiniciar', async () => {
  const ana = await enter('ana@exemplo.com.br', 'Ana', 'DEV');
  const bia = await enter('bia@parceiro.exemplo.com.br', 'Bia', 'DEV');
  const caio = await enter('caio@exemplo.com.br', 'Caio', 'QA');
  const duda = await enter('duda@exemplo.com.br', 'Duda', 'ESPECTADOR');

  await card(ana, '3').click();
  await card(bia, '2').click();
  await card(caio, 'impossível').click();
  await duda.waitForFunction(() => document.querySelectorAll('.chip.back').length === 3);

  assert.equal(await duda.locator('#my-cards').isHidden(), true);
  assert.equal(await duda.locator('.chip.shown').count(), 0);
  const peek = await duda.evaluate(async () => {
    const { getDatabase, ref, get } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js');
    try { await get(ref(getDatabase(), 'votes')); return 'LEU'; } catch (e) { return e.message; }
  });
  assert.match(peek, /ermission/i, 'voto alheio negado pelo servidor antes de revelar');

  await duda.click('#reveal');
  await ana.waitForFunction(() => document.querySelectorAll('.chip.shown').length === 3);
  assert.match(await text(ana, '#avg-DEV'), /2,5/);
  assert.match(await text(ana, '#avg-QA'), /Sem média/);

  await card(caio, '1,5').click();
  await card(bia, '5').click();
  await ana.waitForFunction(() => document.querySelector('#avg-DEV').innerText.includes('4'));
  await ana.waitForFunction(() => document.querySelector('#avg-QA').innerText.includes('1,5'));

  await bia.click('#reset');
  // Todas as pessoas que votam voltam a "aguardando", quantas forem.
  await duda.waitForFunction(() => {
    const rows = document.querySelectorAll('#list-DEV li:not(.empty), #list-QA li:not(.empty)');
    return rows.length > 0 && document.querySelectorAll('.chip.waiting').length === rows.length;
  });
  assert.match(await text(duda, '#avg-DEV'), /aparece ao revelar/);

  await caio.reload();
  await caio.waitForSelector('#screen-board:not([hidden])');

  for (const p of [ana, bia, caio, duda]) await p.context().close();
});

// Proteção para a troca de papel, antes de juntar as gravações dela numa só.
test('trocar para espectador tira a pessoa do painel e apaga o voto', async () => {
  const eva = await enter('eva@exemplo.com.br', 'Eva', 'DEV');
  const fabio = await enter('fabio@exemplo.com.br', 'Fabio', 'QA');

  await card(eva, '2').click();
  await fabio.waitForFunction(() => [...document.querySelectorAll('#list-DEV li')]
    .some((li) => li.innerText.includes('Eva') && li.classList.contains('voted')));

  await eva.selectOption('#role-select', 'ESPECTADOR');
  await fabio.waitForFunction(() => document.querySelector('#spectator-list').innerText.includes('Eva'));
  assert.doesNotMatch(await text(fabio, '#list-DEV'), /Eva/);
  await eva.waitForSelector('#my-cards', { state: 'hidden' });

  await eva.selectOption('#role-select', 'DEV');
  await eva.waitForSelector('#my-cards:not([hidden])');
  assert.equal(await eva.locator('#cards button.selected').count(), 0, 'voto antigo não volta');
  await fabio.waitForFunction(() => [...document.querySelectorAll('#list-DEV li')]
    .some((li) => li.innerText.includes('Eva') && !li.classList.contains('voted')));

  for (const p of [eva, fabio]) await p.context().close();
});

// Com o servidor sem responder, a tela não pode mudar antes da confirmação.
// Estado Red: o Firebase aplica a alteração na tela antes de o servidor confirmar.
async function setOnline(page, online) {
  await page.evaluate(async (on) => {
    const m = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js');
    if (on) m.goOnline(m.getDatabase()); else m.goOffline(m.getDatabase());
  }, online);
}

test('troca de papel e voto só aparecem depois que o servidor confirma', async () => {
  const gil = await enter('gil@exemplo.com.br', 'Gil', 'DEV');

  await setOnline(gil, false);
  await card(gil, '3').click();
  await gil.waitForSelector('#overlay:not([hidden])');
  assert.equal(await gil.locator('#cards button.selected').count(), 0, 'carta só marca depois de confirmar');
  await setOnline(gil, true);
  await gil.waitForSelector('#overlay', { state: 'hidden' });
  await gil.waitForSelector('#cards button.selected');

  await setOnline(gil, false);
  await gil.selectOption('#role-select', 'ESPECTADOR');
  await gil.waitForSelector('#overlay:not([hidden])');
  assert.match(await text(gil, '#list-DEV'), /Gil/, 'continua no painel DEV enquanto espera');
  assert.equal(await gil.locator('#my-cards').isVisible(), true);
  await setOnline(gil, true);
  await gil.waitForSelector('#overlay', { state: 'hidden' });
  await gil.waitForFunction(() => document.querySelector('#spectator-list').innerText.includes('Gil'));
  assert.doesNotMatch(await text(gil, '#list-DEV'), /Gil/);

  await gil.context().close();
});

// Estado Red: o nome no topo ainda não é clicável.
test('clicar no próprio nome permite trocar, e todos veem o nome novo', async () => {
  const helena = await enter('helena@exemplo.com.br', 'Helena', 'QA');
  const ivo = await enter('ivo@exemplo.com.br', 'Ivo', 'DEV');

  // Esc cancela sem salvar.
  await helena.click('#who-name');
  await helena.fill('#name-input', 'Outro nome');
  await helena.press('#name-input', 'Escape');
  assert.equal(await helena.locator('#name-form').isHidden(), true);
  assert.equal(await text(helena, '#who-name'), 'Helena');

  // Enter salva, e o nome muda para todos.
  await helena.click('#who-name');
  assert.equal(await helena.inputValue('#name-input'), 'Helena');
  await helena.fill('#name-input', 'Helena Souza');
  await helena.press('#name-input', 'Enter');
  await helena.waitForSelector('#overlay', { state: 'hidden' });
  await helena.waitForFunction(() => document.querySelector('#who-name').innerText === 'Helena Souza');
  await ivo.waitForFunction(() => document.querySelector('#list-QA').innerText.includes('Helena Souza'));

  // O nome novo sobrevive a recarregar a página.
  await helena.reload();
  await helena.waitForSelector('#screen-board:not([hidden])');
  await helena.waitForFunction(() => document.querySelector('#who-name').innerText === 'Helena Souza');

  for (const p of [helena, ivo]) await p.context().close();
});
