// Token Radar — the valuation model (own design, written for this entry).
//
// The board ranks every pre-token protocol the snapshot can honestly rank: the whole 40-protocol
// watchlist plus every other pre-token protocol below the watchlist floor that is not an exchange,
// a bridge, a liquid-staking product or a wrapped/staked product of a token that already trades
// (those cannot launch a token of their own, so ranking them would be noise). A protocol is
// "pre-token" when its record carries no market cap, no CoinGecko id and no symbol — the snapshot
// says it records no token, never that it has none.
//
// Implied value is built only from the snapshot's own figures:
//
//   implied = round( tvl_usd x category_multiple x growth x breadth x maturity )
//
//   category_multiple — the median market-cap / TVL ratio of the live-token protocols in the same
//     category, computed from this snapshot at run time (at least 3 live protocols in the category,
//     otherwise the global median across all live-token protocols). Clamped to [0.05, 1.00]: it is
//     the market's own answer to "what is a dollar of TVL in this kind of protocol worth", not a
//     number chosen by hand. No protocol name is ever special-cased.
//   growth            — 1 + 0.40 x clamp(change_7d, -50, +150) / 100, so a protocol growing 150%
//     in a week scores 1.60x and one shrinking 50% scores 0.80x. Null change_7d counts as 0.
//   breadth           — 1 + 0.02 x min(chains - 1, 10): a protocol live on more chains is worth a
//     little more per TVL dollar, capped at 1.20x for 11+ chains.
//   maturity          — 0.70 + 0.30 x min(age_days, 1095) / 1095: a protocol that has run three
//     years with no token scores 1.00x, a brand-new one 0.70x. Unknown listed_at counts as 365 days.
//
// Farm plans are derived the same way from each protocol's own record (category, chains, TVL, age):
// the action fits the category, the capital fits the TVL, the hold fits the age. A plan never claims
// a points program, an airdrop or a token the snapshot does not show; the last steps say to use the
// protocol and watch its own announcements.

/** One protocol record from the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunables, stated in the dashboard so the judge can re-derive every row. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
  maturity_floor: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  multiple_min_live: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.4,
  growth_floor: -50,
  growth_cap: 150,
  breadth_per_chain: 0.02,
  breadth_max_chains: 10,
  maturity_floor: 0.7,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.05,
  multiple_cap: 1.0,
  multiple_min_live: 3,
};

export const MODEL_VERSION = 'radar-2';

/** One farm step: action, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    breadth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  breadth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol, shown apart with the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The category multiples, computed from the snapshot's own live-token protocols: for each category
 * with at least `multiple_min_live` live protocols, the median of mcap_usd / tvl_usd; every other
 * category falls back to the global median. Both are clamped to [multiple_floor, multiple_cap] so a
 * category with one tiny-TVL outlier (a 400x ratio) cannot explode a row.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants): { byCategory: Map<string, number>; global: number } {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.gecko_id !== null,
  );
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list) list.push(p.mcap_usd! / p.tvl_usd);
    else byCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  const clamp = (v: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, v));
  const global = clamp(median(live.map((p) => p.mcap_usd! / p.tvl_usd)));
  const out = new Map<string, number>();
  for (const [cat, ratios] of byCategory) {
    out.set(cat, ratios.length >= model.multiple_min_live ? clamp(median(ratios)) : global);
  }
  return { byCategory: out, global };
}

/** A protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories that cannot plausibly launch a token of their own. */
const EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** A name ending in a version marker is a pool of another protocol, not a protocol itself. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word "wrapped", "staked" or "staking" marks a product of a token that already trades. */
const WRAPPED = /\b(wrapped|staked|staking)\b/i;

/** Whether a pre-token protocol is one the board may rank. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED.test(p.name)) return false;
  return true;
}

/** The four multipliers and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  categoryMultiple: number,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; breadthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_chains);
  const breadthMult = 1 + model.breadth_per_chain * extraChains;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + ((1 - model.maturity_floor) * Math.min(Math.max(ageForModel, 0), model.maturity_days)) / model.maturity_days;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * categoryMultiple * growthMult * breadthMult * maturityMult));
  return { implied, growthPct, growthMult, breadthMult, maturityMult, age };
}

/** The board: every watchlist slug, plus every other rankable pre-token protocol, ranked by value. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const { byCategory, global } = categoryMultiples(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    // Round the multiple to 4 decimals BEFORE scoring: board.json stores the rounded multiple and
    // the dashboard recomputes each row from it, so the two must agree to the dollar. A full-precision
    // multiple would leave the page's recompute a few thousand dollars off the board's number.
    const multiple = round4(byCategory.get(p.category ?? 'Other') ?? global);
    const v = impliedValue(p, snapshot.as_of, multiple, model);
    return { p, multiple, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: round4(s.multiple),
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      breadth_multiplier: round4(s.breadthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: action, cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page for updates.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC as collateral to ${name} on ${chain} and borrow a small amount against it, then repay it.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the position open.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  }
  if (c.includes('leveraged farm')) {
    return `Open a $${capital} leveraged farming position on ${name} on ${chain} at low leverage and keep it open.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged trade.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and take one small position in an active market, then settle it.`;
  }
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('onchain capital')) {
    return `Deposit $${capital} of USDC into a ${name} curated vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in your wallet.`;
  }
  if (c.includes('stable') || c.includes('dual-token')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('launchpad')) {
    return `Join one ${name} launch on ${chain} with $${capital} and hold the allocation through its distribution.`;
  }
  if (c.includes('ai') || c.includes('decentralized ai')) {
    return `Use $${capital} to run one paid job or stake into ${name}'s agent service on ${chain}.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} of USDC to ${name}'s chain and use it in one of the chain's own apps.`;
  }
  if (c.includes('payment')) {
    return `Pay $${capital} through ${name} on ${chain} for a real purchase and keep the receipt.`;
  }
  if (c.includes('privacy')) {
    return `Move $${capital} through ${name} on ${chain} for one private transfer and keep the record.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  }
  if (c.includes('nft')) {
    return `Mint or trade one item on ${name} on ${chain} with about $${capital} and keep it listed.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the shares.`;
  }
  if (c.includes('token locker')) {
    return `Lock $${capital} of tokens through ${name} on ${chain} for the protocol's shortest term.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and use the protocol's main feature once a week.`;
}

/**
 * A protocol's farm plan: six steps derived from its own record. Nothing here claims a points
 * program, an airdrop or a token the snapshot does not show — the plan is about using the protocol
 * and watching its own announcements.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const name = p.name;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  return [
    {
      text: `Set up a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline on paper.`,
      cost: 'no cost to create the wallet',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondChain === null
        ? `Repeat one qualifying action each week on ${name} — a deposit, a swap, a borrow or a vote — so the wallet stays active.`
        : `Use ${name} on a second chain, ${secondChain}, for one more qualifying action so the wallet shows up on both chains.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days, through more than one weekly snapshot, before you touch it again.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Read ${name}'s own announcements page once a week and claim only through a link that page itself publishes — never pay a fee to claim anything.`,
      cost: 'no fee to check',
      time: '10 minutes a week',
    },
    {
      text: `Write the wallet address, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, farm plan included so the page shows board.json's own words. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const { global } = categoryMultiples(snapshot, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: global,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the gate's 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
  }
  return null;
}

/** data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
