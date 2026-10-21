// Ponta a ponta no navegador, contra os emuladores de banco e de login.
// Rodar com: npm run test:e2e
// Estado Red do link por e-mail: a tela de login ainda não tem campo de e-mail.
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

// Link que o emulador "enviou" por e-mail, no formato em que ele chega ao app.
async function linkFor(email) {
  const res = await fetch(`http://localhost:9099/emulator/v1/projects/${PROJECT}/oobCodes`);
  const { oobCodes } = await res.json();
  const code = oobCodes.filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN').at(-1);
  assert.ok(code, `link enviado para ${email}`);
  const params = new URL(code.oobLink).searchParams;
  return `${APP}&mode=signIn&oobCode=${params.get('oobCode')}&apiKey=${params.get('apiKey')}&lang=pt`;
}

async function requestLink(page, email) {
  await page.fill('#login-email', email);
  await page.click('#login-link-form button[type=submit]');
  await page.waitForSelector('#link-sent:not([hidden])');
}

async function enter(email, name, role) {
  const page = await newPage();
  await requestLink(page, email);
  await page.goto(await linkFor(email));
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

test('a tela de login oferece só o link por e-mail', async () => {
  const page = await newPage();
  assert.equal(await page.locator('#login-email').isVisible(), true);
  assert.equal(await page.locator('#login-google').count(), 0);
  await page.context().close();
});

test('o link por e-mail entra na sala e limpa o código da barra de endereço', async () => {
  const page = await newPage();
  await requestLink(page, 'link@exemplo.com.br');
  assert.match(await text(page, '#link-sent'), /link@exemplo\.com\.br/);
  await page.goto(await linkFor('link@exemplo.com.br'));
  await page.waitForSelector('#screen-profile:not([hidden])');
  assert.doesNotMatch(page.url(), /oobCode/);
  await page.context().close();
});

test('link aberto em outro navegador pede o e-mail e recusa e-mail diferente', async () => {
  const first = await newPage();
  await requestLink(first, 'outro@exemplo.com.br');
  const link = await linkFor('outro@exemplo.com.br');
  await first.context().close();

  const page = await (await browser.newContext()).newPage();
  await page.goto(link);
  await page.waitForSelector('#screen-confirm:not([hidden])');
  await page.fill('#confirm-email', 'errado@exemplo.com.br');
  await page.click('#confirm-form button[type=submit]');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await text(page, '#error'), /não confere/);

  await page.fill('#confirm-email', 'outro@exemplo.com.br');
  await page.click('#confirm-form button[type=submit]');
  await page.waitForSelector('#screen-profile:not([hidden])');
  await page.context().close();
});

test('link já usado avisa e volta para a tela de login', async () => {
  const page = await newPage();
  await requestLink(page, 'usado@exemplo.com.br');
  const link = await linkFor('usado@exemplo.com.br');
  await page.goto(link);
  await page.waitForSelector('#screen-profile:not([hidden])');
  await page.context().close();

  const again = await newPage();
  await again.evaluate(() => localStorage.setItem('emailForSignIn', 'usado@exemplo.com.br'));
  await again.goto(link);
  await again.waitForSelector('#error:not([hidden])');
  assert.match(await text(again, '#error'), /expirou ou já foi usado/);
  await again.waitForSelector('#screen-login:not([hidden])');
  await again.context().close();
});

test('e-mail fora da lista entra pelo link mas é barrado pelo servidor', async () => {
  const page = await newPage();
  await requestLink(page, 'intruso@gmail.com');
  await page.goto(await linkFor('intruso@gmail.com'));
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
  await duda.waitForFunction(() => document.querySelectorAll('.chip.waiting').length === 3);
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
