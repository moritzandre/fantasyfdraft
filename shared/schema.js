// schema.js — the board.json contract, validated at app boot and by
// verify_board.py's emitter (Python writes it, this checks it, the app trusts
// it). Deliberately hand-rolled: no dependency, runs in Node and Safari.
//
// board.json shape (~300 KB, committed, read-only to the app):
// {
//   schema: 1,
//   buildHash: "7f3a91c",            // sha of inputs; shown in app header + PDF footers
//   builtAt: "2026-08-14T21:07:00Z",
//   configFingerprint: "b21e40aa",   // sha256[:8] of config/league.json
//   sources: { espn: {fetchedAt, count}, ffc: {...}, nflverse: {...}, ... },
//   checks:  [ {name, status: "pass"|"fail", detail} ],
//   teams:   { DET: { bye: 6, sosEarly: -2.1, sosPlayoff: 0.4 } , ... },
//   players: [ {
//     idx,                            // dense index — the id used everywhere else
//     id, ids: {espn, sleeper, ffc, fantasycalc},
//     name, short, pos, team, bye, injuryStatus,
//     proj: { halfPpr, ppr, rec, recYd, recTd, ruAtt, ruYd, ruTd, tgt },
//     deltaHalfPpr,                   // 0.5·(rec − rec_replacement) — printed column
//     weeklyHalfPpr: [18 numbers],    // bye = the 0.0 week
//     sigmaProj, gamesExpected, eff,
//     adp: { mu, sd, hi, lo, n, espnMu, divergence, sigmaFinal, sigmaSource },
//     tier, tierLetter, posRank, overallRank, flags: [...]
//   } ],
//   tiers: [ {pos, tier, letter, members: [idx], cliffPoints, meanGap, tierSep} ],
//   baselinesPrior: { thetaStar, r: {QB,RB,WR,TE}, flexAlloc: {RB,WR,TE} },
//   slimSleeperMap: { "<sleeper_id>": idx }
// }

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

/** Validate a board object. Returns a list of problems; empty ⇒ valid. */
export function validateBoard(board) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };

  need(board && typeof board === 'object', 'board is not an object');
  if (!board || typeof board !== 'object') return errs;

  need(board.schema === 1, `unknown schema ${board?.schema}`);
  need(typeof board.buildHash === 'string' && board.buildHash.length >= 7, 'missing buildHash');
  need(typeof board.builtAt === 'string', 'missing builtAt');
  need(typeof board.configFingerprint === 'string', 'missing configFingerprint');
  need(Array.isArray(board.players) && board.players.length >= 200,
    `players: expected ≥200, got ${board.players?.length ?? 0}`);
  need(Array.isArray(board.checks) && board.checks.every((c) => c.status === 'pass'),
    'one or more pipeline checks did not pass');

  for (const [i, p] of (board.players ?? []).entries()) {
    if (i !== p.idx) { errs.push(`players[${i}].idx=${p.idx} — dense index broken`); break; }
    if (!POSITIONS.has(p.pos)) { errs.push(`players[${i}] bad pos ${p.pos}`); break; }
    if (!(p.proj?.halfPpr >= 0)) { errs.push(`players[${i}] missing proj.halfPpr`); break; }
    if (p.proj.rec > 0 && !(p.proj.halfPpr < p.proj.ppr)) {
      errs.push(`players[${i}] ${p.name}: half_ppr must be < ppr for pass-catchers`);
      break;
    }
    if (!(p.adp?.mu > 0) || !(p.adp?.sigmaFinal > 0)) {
      errs.push(`players[${i}] ${p.name}: missing adp.mu/sigmaFinal`);
      break;
    }
  }

  need(Array.isArray(board.tiers) && board.tiers.length > 0, 'missing tiers');
  need(board.baselinesPrior?.r && board.baselinesPrior?.flexAlloc, 'missing baselinesPrior');
  return errs;
}
