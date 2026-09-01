/**
 * Retrieval prefilter — keeps every downstream decision O(K) as the
 * scenario pool grows.
 *
 * Routing is a discrimination task and gets harder as the candidate list
 * grows; retrieval is a lookup task and does not. So the pool is ranked
 * first and only the top few candidates are ever compared in detail. The
 * lexical scorer here is synchronous and dependency-free, which is what lets
 * the router stay a pure function; the async `Retriever` seam exists so an
 * embedding-backed ranker can be dropped in without touching the router.
 */

const LATIN_TOKEN = /[a-z0-9]+/g;
// Han + Kana + Hangul runs. Punctuation and whitespace break a run, so
// bigrams never span a phrase boundary.
const CJK_RUN = /[一-鿿぀-ヿ가-힣]+/g;

/**
 * Split text into matchable tokens: Latin/digit words plus CJK character
 * bigrams. CJK has no whitespace word boundaries, so bigrams within a
 * contiguous run are the standard zero-dependency unit; a one-character run
 * is kept whole so it does not vanish.
 */
export function tokenize(text: string): readonly string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [...(lowered.match(LATIN_TOKEN) ?? [])];
  for (const run of lowered.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

export interface ScoredDoc {
  readonly id: string;
  readonly score: number;
}

/**
 * IDF-weighted token overlap, normalized by sqrt(document length) so verbose
 * documents do not win on bulk alone. Tokens shared by most documents (a
 * "查询" that appears everywhere) are down-weighted, so the discriminative
 * ones decide the order. Ties keep insertion order.
 */
export function lexicalRank(query: string, docs: ReadonlyMap<string, string>): readonly ScoredDoc[] {
  if (docs.size === 0) return [];
  const queryTokens = new Set(tokenize(query));
  const docTokens = new Map<string, ReadonlySet<string>>();
  const documentFrequency = new Map<string, number>();

  for (const [id, text] of docs) {
    const tokens = new Set(tokenize(text));
    docTokens.set(id, tokens);
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }

  const total = docs.size;
  const scored: ScoredDoc[] = [];
  for (const [id, tokens] of docTokens) {
    let weight = 0;
    for (const token of queryTokens) {
      if (!tokens.has(token)) continue;
      weight += Math.log(1 + total / (documentFrequency.get(token) ?? 1));
    }
    scored.push({ id, score: tokens.size === 0 ? 0 : weight / Math.sqrt(tokens.size) });
  }
  // Stable sort: Array#sort is stable in V8, so equal scores keep map order.
  return [...scored].sort((a, b) => b.score - a.score);
}

/**
 * Share of an anchor's tokens that the query covers. Anchors are stored with
 * their slot values stripped, so this measures "is the query the same
 * request shape", not "is it the same string".
 */
export function anchorCoverage(query: string, anchor: string): number {
  const anchorTokens = new Set(tokenize(anchor));
  // A near-empty anchor (the whole phrasing was one slot value) would score
  // trivially high against anything. Refuse to match on it.
  if (anchorTokens.size < 2) return 0;
  const queryTokens = new Set(tokenize(query));
  let hits = 0;
  for (const token of anchorTokens) if (queryTokens.has(token)) hits += 1;
  return hits / anchorTokens.size;
}

/** Ranks candidate documents best-first. Async so an embedder can implement it. */
export interface Retriever {
  rank(query: string, docs: ReadonlyMap<string, string>): Promise<readonly ScoredDoc[]>;
}

/** The default retriever: `lexicalRank`, wrapped in the async seam. */
export class LexicalRetriever implements Retriever {
  async rank(query: string, docs: ReadonlyMap<string, string>): Promise<readonly ScoredDoc[]> {
    return lexicalRank(query, docs);
  }
}

/** Best-first ids, truncated to `topK`. Scores of zero are dropped. */
export function topCandidates(ranked: readonly ScoredDoc[], topK: number): readonly string[] {
  return ranked
    .filter((doc) => doc.score > 0)
    .slice(0, Math.max(0, topK))
    .map((doc) => doc.id);
}
