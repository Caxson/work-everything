import { describe, expect, it } from 'vitest';
import { anchorCoverage, LexicalRetriever, lexicalRank, tokenize, topCandidates } from '../src/core/prefilter.js';

describe('prefilter', () => {
  it('splits latin words and CJK bigrams', () => {
    expect(tokenize('Deploy CI-2')).toEqual(['deploy', 'ci', '2']);
    expect(tokenize('天气预报')).toEqual(['天气', '气预', '预报']);
  });

  it('keeps a one-character CJK run instead of dropping it', () => {
    expect(tokenize('查 build')).toEqual(['build', '查']);
  });

  it('does not create bigrams across a punctuation boundary', () => {
    expect(tokenize('构建，失败')).toEqual(['构建', '失败']);
  });

  it('ranks the document that shares discriminative tokens first', () => {
    const docs = new Map([
      ['weather', '查询 天气 预报'],
      ['orders', '查询 订单 状态'],
      ['builds', '查询 构建 失败'],
    ]);
    const ranked = lexicalRank('构建 失败 了吗', docs);
    expect(ranked[0]?.id).toBe('builds');
  });

  it('down-weights a token every document shares', () => {
    const docs = new Map([
      ['a', '查询 天气'],
      ['b', '查询 订单'],
    ]);
    const ranked = lexicalRank('查询', docs);
    // "查询" is in both, so neither wins by much and order is stable.
    expect(ranked.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty pool', () => {
    expect(lexicalRank('anything', new Map())).toEqual([]);
    expect(topCandidates([], 5)).toEqual([]);
  });

  it('drops zero-scoring docs from the candidate list', () => {
    const ranked = lexicalRank('unrelated words', new Map([['a', '完全 不同']]));
    expect(topCandidates(ranked, 5)).toEqual([]);
  });

  it('measures anchor coverage, refusing near-empty anchors', () => {
    expect(anchorCoverage('check the build log now', 'check the build log')).toBeGreaterThan(0.9);
    expect(anchorCoverage('anything at all', 'x')).toBe(0);
    expect(anchorCoverage('completely different', 'check the build log')).toBe(0);
  });

  it('exposes the same ranking through the async seam', async () => {
    const ranked = await new LexicalRetriever().rank('build', new Map([['builds', 'build failures']]));
    expect(ranked[0]?.id).toBe('builds');
  });
});
