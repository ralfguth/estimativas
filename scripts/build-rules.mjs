// Monta database.rules.json a partir do modelo versionado e da lista local de
// acesso (allowed.txt, fora do git). Cada linha é um domínio (exemplo.com.br)
// ou um e-mail exato (pessoa@exemplo.com). Uso: node scripts/build-rules.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const LOCAL_PART = /^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*$/i;

const escape = (s) => s.toLowerCase().replace(/[.+]/g, (c) => `[${c}]`);

export function parseAllowList(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function emailRegex(entries) {
  if (!entries.length) throw new Error('lista de acesso vazia');
  const domains = [];
  const emails = [];
  for (const entry of entries) {
    const [local, domain, ...rest] = entry.includes('@') ? entry.split('@') : [null, entry];
    if (rest.length || !DOMAIN.test(domain) || (local !== null && !LOCAL_PART.test(local))) {
      throw new Error(`entrada inválida: ${entry}`);
    }
    if (local === null) domains.push(escape(domain));
    else emails.push(`${escape(local)}@${escape(domain)}`);
  }
  const options = [...(domains.length ? [`[^@ ]+@(${domains.join('|')})`] : []), ...emails];
  return `/^(${options.join('|')})$/i`;
}

export function buildRules(template, entries) {
  return template.replaceAll('__EMAIL_REGEX__', emailRegex(entries));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const entries = parseAllowList(readFileSync(new URL('allowed.txt', root), 'utf8'));
  const template = readFileSync(new URL('database.rules.template.json', root), 'utf8');
  writeFileSync(new URL('database.rules.json', root), buildRules(template, entries));
  console.log(`database.rules.json montado com ${entries.length} entrada(s)`);
}
