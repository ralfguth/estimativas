import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut, connectAuthEmulator,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  // sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  // GoogleAuthProvider, signInWithPopup, signInWithRedirect,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, update, remove, set, get, serverTimestamp, connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js?v=9';
import {
  buildView, staleUids, VOTE_OPTIONS, IMPOSSIBLE, VOTING_ROLES,
} from './src/room.js?v=9';

const $ = (id) => document.getElementById(id);
const screens = ['setup', 'loading', 'login', 'profile', 'board'];

function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
  if (msg) showNotice('');
}

function showNotice(msg) {
  $('notice').textContent = msg;
  $('notice').hidden = !msg;
}

// Botão em espera: gira um indicador e troca o texto enquanto o servidor responde.
function busy(button, on, label) {
  button.disabled = on;
  button.classList.toggle('busy', on);
  button.setAttribute('aria-busy', String(on));
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

// Bloqueia a tela enquanto o servidor confirma uma alteração. Só aparece se a
// resposta demorar, para não piscar quando o Firebase está rápido. Sem conexão o
// Firebase guarda a alteração e a confirmação pode não chegar, então a tela
// destrava sozinha depois de um tempo.
let pendingOps = 0;
async function withOverlay(label, action) {
  pendingOps += 1;
  const showTimer = setTimeout(() => {
    $('overlay-text').textContent = label;
    $('overlay').hidden = false;
    document.querySelector('main').inert = true;
  }, 250);
  const giveUp = setTimeout(() => {
    $('overlay').hidden = true;
    document.querySelector('main').inert = false;
    showError('O servidor está demorando para responder. A alteração será enviada assim que a conexão voltar.');
  }, 15000);
  try {
    return await action();
  } finally {
    clearTimeout(showTimer);
    clearTimeout(giveUp);
    pendingOps -= 1;
    if (pendingOps === 0) {
      $('overlay').hidden = true;
      document.querySelector('main').inert = false;
    }
  }
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Tema: automático, claro ou escuro.
$('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  store.set('theme', root.dataset.theme);
});

// Teste local com os emuladores do Firebase: http://localhost:8080/?emulador
const useEmulator = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulador');

if (firebaseConfig.apiKey === 'COLE_AQUI' && !useEmulator) {
  show('setup');
  throw new Error('firebase-config.js não preenchido');
}

const app = initializeApp(useEmulator
  ? { apiKey: 'demo', projectId: 'demo-estimativas', databaseURL: 'http://localhost:9000?ns=demo-estimativas-default-rtdb' }
  : firebaseConfig);
const auth = getAuth(app);
auth.languageCode = 'pt';
const db = getDatabase(app);

if (useEmulator) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, 'localhost', 9000);
  // Cria a conta (ou entra nela) com uma senha fixa, só no emulador.
  window.emulatorLogin = async (email) => {
    const password = 'senha-do-emulador';
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      if (err.code !== 'auth/email-already-in-use') throw err;
      await signInWithEmailAndPassword(auth, email, password);
    }
  };
}

// Estado vindo do banco.
const data = { participants: {}, voted: {}, revealed: false, myVote: null, allVotes: {} };
let serverOffset = 0;
let me = null; // usuário do Firebase Auth
let unsubs = [];
let unsubAllVotes = null;

const serverNow = () => Date.now() + serverOffset;

// ---------- Login com Google (desligado) ----------
// A rede corporativa bloqueia o login com Google. Para religar, descomente este
// trecho, o import de GoogleAuthProvider, signInWithPopup e signInWithRedirect,
// e o botão em index.html.
//
// const provider = new GoogleAuthProvider();
// // Sempre mostra a escolha de conta, para quem tem mais de uma conta no mesmo navegador.
// provider.setCustomParameters({ prompt: 'select_account' });
//
// $('login-google').addEventListener('click', async () => {
//   showError('');
//   try {
//     await signInWithPopup(auth, provider);
//   } catch (err) {
//     if (err.code === 'auth/popup-blocked') await signInWithRedirect(auth, provider);
//     else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
//       showError(`Não foi possível entrar (${err.code ?? err.message}).`);
//     }
//   }
// });

// ---------- Login por link no e-mail (desligado) ----------
// O plano gratuito do Firebase só envia 5 e-mails de link por dia. Para religar,
// descomente este trecho, o import de sendSignInLinkToEmail, isSignInWithEmailLink
// e signInWithEmailLink, e os formulários comentados em index.html.
//
// function linkSettings() {
//   return { url: location.origin + location.pathname + (useEmulator ? '?emulador' : ''), handleCodeInApp: true };
// }
//
// $('login-link-form').addEventListener('submit', async (e) => {
//   e.preventDefault();
//   showError('');
//   const email = $('login-email').value.trim().toLowerCase();
//   const button = e.submitter;
//   busy(button, true, 'Enviando…');
//   try {
//     await sendSignInLinkToEmail(auth, email, linkSettings());
//     store.set('emailForSignIn', email);
//     $('sent-to').textContent = email;
//     $('login-link-form').hidden = true;
//     $('link-sent').hidden = false;
//   } catch (err) {
//     showError(`Não foi possível enviar o link (${err.code ?? err.message}).`);
//   } finally {
//     busy(button, false);
//   }
// });
//
// $('login-again').addEventListener('click', () => {
//   $('login-link-form').hidden = false;
//   $('link-sent').hidden = true;
// });
//
// // O link chega com um código de uso único na barra de endereço. Ele é guardado
// // e a barra é limpa antes de tudo, para o código não ficar no histórico.
// const incomingLink = isSignInWithEmailLink(auth, location.href) ? location.href : null;
// if (incomingLink) history.replaceState(null, '', location.pathname + (useEmulator ? '?emulador' : ''));
// let linkPending = Boolean(incomingLink);
//
// async function finishLink(email) {
//   showError('');
//   try {
//     await signInWithEmailLink(auth, email, incomingLink);
//     store.del('emailForSignIn');
//     linkPending = false;
//   } catch (err) {
//     if (err.code === 'auth/invalid-email') {
//       showError('Este e-mail não confere com o do link.');
//       show('confirm');
//       return;
//     }
//     linkPending = false;
//     store.del('emailForSignIn');
//     const expired = err.code === 'auth/invalid-action-code' || err.code === 'auth/expired-action-code';
//     showError(expired
//       ? 'Este link expirou ou já foi usado. Peça um novo.'
//       : `Não foi possível entrar (${err.code ?? err.message}).`);
//     show('login');
//   }
// }
//
// $('confirm-form').addEventListener('submit', async (e) => {
//   e.preventDefault();
//   const button = e.submitter;
//   busy(button, true, 'Entrando…');
//   try {
//     await finishLink($('confirm-email').value.trim().toLowerCase());
//   } finally {
//     busy(button, false);
//   }
// });
//
// if (incomingLink) {
//   const saved = store.get('emailForSignIn');
//   if (saved) finishLink(saved);
//   else show('confirm');
// }
//

$('logout').addEventListener('click', async () => {
  await signOut(auth);
});

// ---------- Login com e-mail e senha ----------
// No primeiro acesso a pessoa cria a conta. O e-mail não é confirmado (decisão do
// usuário): as regras do banco só conferem se o domínio está na lista.

function actionSettings() {
  return { url: location.origin + location.pathname + (useEmulator ? '?emulador' : '') };
}

function authMessage(err, fallback) {
  switch (err.code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'E-mail ou senha incorretos.';
    case 'auth/email-already-in-use':
      return 'Esse e-mail já tem conta. Use "Entrar" ou "Esqueci minha senha".';
    case 'auth/weak-password':
      return 'A senha precisa ter pelo menos 6 caracteres.';
    case 'auth/invalid-email':
      return 'Esse e-mail não é válido.';
    case 'auth/too-many-requests':
      return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.';
    case 'auth/quota-exceeded':
      return 'O limite diário de e-mails foi atingido. Tente de novo amanhã.';
    default:
      return `${fallback} (${err.code ?? err.message}).`;
  }
}

const credentials = () => ({
  email: $('login-email').value.trim().toLowerCase(),
  password: $('login-password').value,
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const button = e.submitter;
  busy(button, true, 'Entrando…');
  try {
    const { email, password } = credentials();
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    showError(authMessage(err, 'Não foi possível entrar'));
  } finally {
    busy(button, false);
  }
});

$('signup').addEventListener('click', async (e) => {
  if (!$('login-form').reportValidity()) return;
  showError('');
  const button = e.currentTarget;
  busy(button, true, 'Criando conta…');
  try {
    const { email, password } = credentials();
    await createUserWithEmailAndPassword(auth, email, password);
  } catch (err) {
    showError(authMessage(err, 'Não foi possível criar a conta'));
  } finally {
    busy(button, false);
  }
});

$('forgot').addEventListener('click', async (e) => {
  if (!$('login-email').reportValidity()) return;
  showError('');
  const button = e.currentTarget;
  busy(button, true, 'Enviando…');
  try {
    await sendPasswordResetEmail(auth, credentials().email, actionSettings());
    showNotice('Se esse e-mail tiver conta, enviamos um link para criar uma nova senha.');
  } catch (err) {
    showError(authMessage(err, 'Não foi possível enviar o e-mail'));
  } finally {
    busy(button, false);
  }
});

// ---------- Perfil (nome e papel) ----------

function fillProfileForm() {
  const p = data.participants[me.uid];
  $('profile-name').value = p?.name ?? store.get('name') ?? me.email.split('@')[0];
  const role = p?.role ?? store.get('role');
  for (const r of document.querySelectorAll('input[name="role"]')) r.checked = r.value === role;
}

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const name = $('profile-name').value.trim().slice(0, 40);
  const role = document.querySelector('input[name="role"]:checked')?.value;
  if (!name || !role) return;
  const button = e.submitter;
  busy(button, true, 'Entrando…');
  try {
    await joinRoom(name, role);
    store.set('name', name);
    store.set('role', role);
    profileDone = true;
    render();
  } catch (err) {
    showError(`Não foi possível entrar na sala (${err.code ?? err.message}).`);
  } finally {
    busy(button, false);
  }
});

let profileDone = false;

async function joinRoom(name, role) {
  const current = data.participants[me.uid];
  const expired = !current || staleUids({ x: current }, serverNow()).length > 0;
  // Quem volta depois de expirar não traz voto antigo de volta.
  if (expired || !VOTING_ROLES.includes(role)) {
    await update(ref(db), { [`votes/${me.uid}`]: null, [`voted/${me.uid}`]: null });
  }
  const changes = { name, email: me.email, role, joinedAt: serverTimestamp() };
  if (expired) await set(ref(db, `participants/${me.uid}`), changes);
  else await update(ref(db, `participants/${me.uid}`), changes);
}

$('role-select').addEventListener('change', (e) => withOverlay('Trocando de papel…', async () => {
  const role = e.target.value;
  // Uma gravação só: quem vira espectador perde o voto junto com a troca.
  const changes = { [`participants/${me.uid}/role`]: role };
  if (!VOTING_ROLES.includes(role)) {
    changes[`votes/${me.uid}`] = null;
    changes[`voted/${me.uid}`] = null;
  }
  try {
    await update(ref(db), changes);
    store.set('role', role);
  } catch (err) {
    showError(`Não foi possível trocar o papel (${err.code ?? err.message}).`);
  }
}));

// ---------- Votação ----------

function vote(value) {
  return withOverlay('Registrando voto…', () => saveVote(value));
}

async function saveVote(value) {
  showError('');
  try {
    if (data.myVote === value) {
      await update(ref(db), { [`votes/${me.uid}`]: null, [`voted/${me.uid}`]: null });
    } else {
      await update(ref(db), {
        [`votes/${me.uid}`]: value,
        [`voted/${me.uid}`]: true,
        [`participants/${me.uid}/lastVoteAt`]: serverTimestamp(),
      });
    }
  } catch (err) {
    showError(`O voto não foi registrado (${err.code ?? err.message}).`);
  }
}

$('reveal').addEventListener('click', () => withOverlay('Revelando…', () => set(ref(db, 'room/revealed'), true)
  .catch((err) => showError(`Não foi possível revelar (${err.code})`))));

$('reset').addEventListener('click', () => withOverlay('Reiniciando…', () => update(ref(db), { votes: null, voted: null, 'room/revealed': false })
  .catch((err) => showError(`Não foi possível reiniciar (${err.code})`))));

// Limpa da sala quem passou de 12h sem votar.
async function sweep() {
  for (const uid of staleUids(data.participants, serverNow())) {
    if (uid !== me?.uid) remove(ref(db, `participants/${uid}`)).catch(() => {});
  }
}

// ---------- Assinaturas no banco ----------

function subscribe() {
  const onErr = (err) => showError(`Sem acesso à sala (${err.code ?? err.message}).`);
  unsubs.push(onValue(ref(db, '.info/serverTimeOffset'), (s) => { serverOffset = s.val() ?? 0; }));
  unsubs.push(onValue(ref(db, 'participants'), (s) => { data.participants = s.val() ?? {}; render(); }, onErr));
  unsubs.push(onValue(ref(db, 'voted'), (s) => { data.voted = s.val() ?? {}; render(); }, onErr));
  unsubs.push(onValue(ref(db, `votes/${me.uid}`), (s) => { data.myVote = s.val(); render(); }, onErr));
  unsubs.push(onValue(ref(db, 'room/revealed'), (s) => {
    data.revealed = s.val() === true;
    // Os votos dos outros só podem ser lidos depois de revelar.
    if (data.revealed && !unsubAllVotes) {
      unsubAllVotes = onValue(ref(db, 'votes'), (v) => { data.allVotes = v.val() ?? {}; render(); }, () => {});
    } else if (!data.revealed && unsubAllVotes) {
      unsubAllVotes();
      unsubAllVotes = null;
      data.allVotes = {};
    }
    render();
  }, onErr));
  const timer = setInterval(() => { sweep(); render(); }, 60 * 1000);
  unsubs.push(() => clearInterval(timer));
}

function unsubscribeAll() {
  for (const u of unsubs) u();
  unsubs = [];
  if (unsubAllVotes) unsubAllVotes();
  unsubAllVotes = null;
}

// ---------- Tela ----------

const fmt = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function voteLabel(v) {
  return v === IMPOSSIBLE ? '1000' : fmt(v);
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

function renderPanel(role, rows, stats, revealed, myUid) {
  const votedCount = rows.filter((r) => r.voted).length;
  $(`count-${role}`).textContent = rows.length ? `${votedCount} de ${rows.length} votaram` : '';
  $(`bar-${role}`).style.width = rows.length ? `${(votedCount / rows.length) * 100}%` : '0';

  const avg = $(`avg-${role}`);
  avg.replaceChildren();
  if (!revealed) {
    avg.append(el('span', { class: 'hint' }, 'A média aparece ao revelar'));
  } else if (stats.average != null) {
    avg.append(el('span', { class: 'label' }, 'Média'), el('span', { class: 'num' }, fmt(stats.average)));
  } else {
    avg.append(el('span', { class: 'hint' }, stats.votes ? 'Sem média' : 'Ninguém votou'));
  }
  if (revealed && stats.impossible) {
    avg.append(el('span', { class: 'note' },
      `${stats.impossible} ${stats.impossible === 1 ? 'voto' : 'votos'} 1000 (impossível de estimar), fora da média`));
  }

  const list = $(`list-${role}`);
  list.replaceChildren(...(rows.length ? rows.map((r, i) => {
    let chip;
    let state;
    if (!r.voted) {
      chip = el('span', { class: 'chip waiting', 'aria-hidden': 'true' });
      state = 'aguardando';
    } else if (revealed && 'vote' in r) {
      const impossible = r.vote === IMPOSSIBLE;
      chip = el('span', { class: `chip shown${impossible ? ' impossible' : ''}`, style: `--i:${i}` }, voteLabel(r.vote));
      state = impossible ? 'impossível de estimar' : 'votou';
    } else {
      chip = el('span', { class: 'chip back', 'aria-hidden': 'true' });
      state = 'votou';
    }
    return el('li', { class: [r.voted ? 'voted' : '', r.uid === myUid ? 'me' : ''].join(' ').trim() },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(r.name)),
      el('span', { class: 'person' },
        el('span', { class: 'name' }, r.uid === myUid ? `${r.name} (você)` : r.name),
        el('span', { class: 'state' }, state)),
      chip);
  }) : [el('li', { class: 'empty' }, 'Ninguém neste papel')]));
}

function renderCards(myVote) {
  $('cards').replaceChildren(...VOTE_OPTIONS.map((v) => {
    const impossible = v === IMPOSSIBLE;
    const label = voteLabel(v);
    return el('button', {
      class: [v === myVote ? 'selected' : '', impossible ? 'impossible-card' : ''].join(' ').trim(),
      'aria-pressed': String(v === myVote),
      'aria-label': impossible ? 'Votar 1000, impossível de estimar' : `Votar ${label}`,
      onclick: () => vote(v),
    },
    impossible ? null : el('span', { class: 'corner top', 'aria-hidden': 'true' }, label),
    el('span', { class: 'face' }, label),
    impossible ? el('small', {}, 'impossível') : null,
    impossible ? null : el('span', { class: 'corner bottom', 'aria-hidden': 'true' }, label));
  }));
}

let wasRevealed = false;

function render() {
  if (!me) return;
  const view = buildView({
    participants: data.participants,
    voted: data.voted,
    votes: { ...data.allVotes, ...(data.myVote != null ? { [me.uid]: data.myVote } : {}) },
    revealed: data.revealed,
    myUid: me.uid,
    now: serverNow(),
  });

  if (!view.me || !profileDone) {
    $('who').hidden = true;
    if ($('screen-profile').hidden) { fillProfileForm(); show('profile'); }
    return;
  }

  show('board');
  $('who').hidden = false;
  $('who-avatar').textContent = initials(view.me.name);
  $('who-name').textContent = view.me.name;
  $('role-select').value = view.me.role;

  $('status').textContent = view.revealed ? 'Votos revelados' : 'Votos ocultos';
  $('status').classList.toggle('revealed', view.revealed);
  $('status-hint').textContent = view.revealed
    ? 'Ainda dá para mudar o voto durante a conversa.'
    : 'Ninguém vê o voto dos outros até alguém revelar.';
  $('reveal').disabled = view.revealed;

  // A animação de virar as cartas só roda na hora em que os votos são revelados.
  const board = $('screen-board');
  if (view.revealed && !wasRevealed) {
    board.classList.add('flip');
    setTimeout(() => board.classList.remove('flip'), 1200);
  }
  wasRevealed = view.revealed;

  for (const role of VOTING_ROLES) renderPanel(role, view.panels[role], view.stats[role], view.revealed, me.uid);

  $('spectators').hidden = !view.spectators.length;
  $('spectator-list').replaceChildren(...view.spectators.map((s) => el('span', { class: 'pill' }, s.name)));

  const voter = VOTING_ROLES.includes(view.me.role);
  $('my-cards').hidden = !voter;
  $('my-cards').className = `my-cards ${voter ? `${view.me.role.toLowerCase()}-voter` : ''}`;
  if (voter) renderCards(view.me.vote);
}

// ---------- Início ----------

async function denyAccess() {
  await signOut(auth);
  showError('Esta conta não tem acesso.');
}

// Abre a sala para quem já confirmou o e-mail.
async function startSession(user) {
  unsubscribeAll();
  me = user;
  profileDone = false;
  show('loading');
  try {
    const snap = await get(ref(db, `participants/${user.uid}`));
    data.participants[user.uid] = snap.val() ?? undefined;
    if (!snap.exists()) delete data.participants[user.uid];
  } catch (err) {
    // Quem pode entrar é decidido só pelas regras do banco.
    if (/permission/i.test(`${err.code} ${err.message}`)) return denyAccess();
    showError(`Não foi possível abrir a sala (${err.code ?? err.message}).`);
    return;
  }
  // Quem já está na sala e ainda dentro do prazo entra direto, renovando a presença.
  const current = data.participants[user.uid];
  if (current && staleUids({ x: current }, Date.now()).length === 0) {
    await update(ref(db, `participants/${user.uid}`), { joinedAt: serverTimestamp() }).catch(() => {});
    profileDone = true;
  }
  subscribe();
  render();
}

onAuthStateChanged(auth, async (user) => {
  unsubscribeAll();
  me = null;
  profileDone = false;
  $('who').hidden = true;
  if (!user) {
    show('login');
    return;
  }
  await startSession(user);
});
