// Regras de cálculo da sala. Sem Firebase aqui: recebe os dados e devolve a tela.

export const VOTE_OPTIONS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 1000];
export const IMPOSSIBLE = 1000;
export const ROLES = ['DEV', 'QA', 'ESPECTADOR'];
export const VOTING_ROLES = ['DEV', 'QA'];
export const EXPIRY_MS = 12 * 60 * 60 * 1000;

// Último sinal de vida: o último voto ou a entrada na sala, o que for mais recente.
function lastActivity(p) {
  return Math.max(p.joinedAt ?? 0, p.lastVoteAt ?? 0);
}

export function staleUids(participants, now) {
  return Object.entries(participants ?? {})
    .filter(([, p]) => now - lastActivity(p) > EXPIRY_MS)
    .map(([uid]) => uid);
}

function summarize(values) {
  const counted = values.filter((v) => v !== IMPOSSIBLE);
  return {
    average: counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : null,
    votes: values.length,
    impossible: values.length - counted.length,
  };
}

export function buildView({ participants, voted, votes, revealed, myUid, now }) {
  participants ??= {};
  voted ??= {};
  votes ??= {};
  const stale = new Set(staleUids(participants, now));
  const active = Object.entries(participants)
    .filter(([uid]) => !stale.has(uid))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'pt-BR'));

  const panels = { DEV: [], QA: [] };
  const spectators = [];
  for (const [uid, p] of active) {
    if (!VOTING_ROLES.includes(p.role)) {
      spectators.push({ uid, name: p.name, email: p.email });
      continue;
    }
    const row = { uid, name: p.name, email: p.email, voted: Boolean(voted[uid]) };
    if (revealed && row.voted && typeof votes[uid] === 'number') row.vote = votes[uid];
    panels[p.role].push(row);
  }

  const stats = { DEV: null, QA: null };
  if (revealed) {
    for (const role of VOTING_ROLES) {
      stats[role] = summarize(panels[role].filter((r) => 'vote' in r).map((r) => r.vote));
    }
  }

  const mine = participants[myUid];
  const me = mine && !stale.has(myUid)
    ? { uid: myUid, name: mine.name, email: mine.email, role: mine.role, vote: typeof votes[myUid] === 'number' ? votes[myUid] : null }
    : null;

  return { revealed: Boolean(revealed), me, panels, spectators, stats };
}
