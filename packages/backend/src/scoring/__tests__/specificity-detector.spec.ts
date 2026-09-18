import { detectSpecificity } from '../specificity-detector';
import { TrieMatch } from '../keyword-trie';
import { ScorerTool } from '../types';

function match(keyword: string, dimension: string, position = 0): TrieMatch {
  return { keyword, dimension, position };
}

describe('detectSpecificity', () => {
  describe('header override', () => {
    it('should return the category with confidence 1.0 when header is valid', () => {
      const result = detectSpecificity([], undefined, 'coding');
      expect(result).toEqual({ category: 'coding', confidence: 1.0 });
    });

    it('should accept all valid categories via header override', () => {
      expect(detectSpecificity([], undefined, 'web_browsing')).toEqual({
        category: 'web_browsing',
        confidence: 1.0,
      });
      expect(detectSpecificity([], undefined, 'data_analysis')).toEqual({
        category: 'data_analysis',
        confidence: 1.0,
      });
      expect(detectSpecificity([], undefined, 'private_docs')).toEqual({
        category: 'private_docs',
        confidence: 1.0,
      });
    });

    it('should fall through to auto-detection when header is invalid', () => {
      const result = detectSpecificity([], undefined, 'invalid_category');
      expect(result).toBeNull();
    });

    it('should fall through to auto-detection when header is empty string', () => {
      const result = detectSpecificity([], undefined, '');
      expect(result).toBeNull();
    });
  });

  describe('auto-detection by keyword matches', () => {
    it('should detect coding when enough codeGeneration matches exist', () => {
      const matches = [
        match('function', 'codeGeneration', 0),
        match('class', 'codeGeneration', 10),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('should detect coding from mixed coding dimensions', () => {
      const matches = [
        match('function', 'codeGeneration', 0),
        match('refactor', 'codeReview', 10),
        match('api', 'technicalTerms', 20),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('should detect coding from codeToProse dimension', () => {
      const matches = [match('explain', 'codeToProse', 0), match('describe', 'codeToProse', 10)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('should detect web_browsing with webBrowsing dimension matches', () => {
      const matches = [match('navigate', 'webBrowsing', 0), match('click', 'webBrowsing', 10)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('should detect data_analysis with domainSpecificity matches', () => {
      const matches = [
        match('regression', 'domainSpecificity', 0),
        match('correlation', 'domainSpecificity', 10),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('data_analysis');
    });

    it('should detect data_analysis with dataAnalysis matches', () => {
      const matches = [match('chart', 'dataAnalysis', 0), match('plot', 'dataAnalysis', 10)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('data_analysis');
    });

    it('should detect data_analysis from mixed data dimensions', () => {
      const matches = [
        match('regression', 'domainSpecificity', 0),
        match('chart', 'dataAnalysis', 10),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('data_analysis');
    });

    it('should detect image_generation with imageGeneration dimension matches', () => {
      const matches = [
        match('generate', 'imageGeneration', 0),
        match('create', 'imageGeneration', 10),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('image_generation');
    });

    it('should detect video_generation with videoGeneration dimension matches', () => {
      const matches = [
        match('generate', 'videoGeneration', 0),
        match('edit', 'videoGeneration', 10),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('video_generation');
    });

    it('should detect social_media with socialMedia dimension matches', () => {
      const matches = [match('post', 'socialMedia', 0), match('tweet', 'socialMedia', 10)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('social_media');
    });

    it('should detect email_management with emailManagement dimension matches', () => {
      const matches = [match('send', 'emailManagement', 0), match('draft', 'emailManagement', 10)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('email_management');
    });

    it('should detect calendar_management with calendarManagement dimension matches', () => {
      const matches = [
        match('schedule', 'calendarManagement', 0),
        match('meeting', 'calendarManagement', 10),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('calendar_management');
    });

    it('should detect trading with trading dimension matches', () => {
      const matches = [match('buy', 'trading', 0), match('sell', 'trading', 10)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });
  });

  describe('no detection', () => {
    it('should return null when there are no matches', () => {
      expect(detectSpecificity([])).toBeNull();
    });

    it('should return null when matches are below threshold', () => {
      const matches = [match('function', 'codeGeneration', 0)];
      // Default threshold is 1, so use explicit threshold=2 to test below-threshold
      expect(detectSpecificity(matches, undefined, undefined, 2)).toBeNull();
    });

    it('should return null when matches belong to irrelevant dimensions', () => {
      const matches = [
        match('hello', 'irrelevantDim', 0),
        match('world', 'anotherDim', 10),
        match('foo', 'yetAnother', 20),
      ];
      expect(detectSpecificity(matches)).toBeNull();
    });
  });

  describe('multiple categories active — highest score wins', () => {
    it('should pick coding over web_browsing when coding has more weighted signal', () => {
      const matches = [
        match('function', 'codeGeneration', 0),
        match('class', 'codeGeneration', 10),
        match('refactor', 'codeReview', 20),
        match('component', 'codeGeneration', 30),
        match('endpoint', 'codeGeneration', 40),
        // single weak web_browsing keyword (default weight 1) — below the
        // web_browsing activation threshold of 3 on its own.
        match('click', 'webBrowsing', 50),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('should pick web_browsing when strong browse anchors dominate', () => {
      const matches = [
        match('function', 'codeGeneration', 0),
        // strong anchors: navigate (3) + browse (3) = 6, clears web_browsing threshold.
        match('navigate', 'webBrowsing', 10),
        match('browse', 'webBrowsing', 20),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });
  });

  describe('tool heuristics', () => {
    it('should boost web_browsing for browser_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'browser_navigate' }, { name: 'browser_click' }];
      const matches = [match('navigate', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('should boost web_browsing for playwright_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'playwright_click' }];
      const matches = [match('click', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('should boost web_browsing for web_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'web_search' }];
      const matches = [match('search', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('should boost coding for code_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'code_edit' }];
      const matches = [match('function', 'codeGeneration', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('should boost coding for editor_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'editor_replace' }];
      const matches = [match('class', 'codeGeneration', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('should handle tool with function.name format', () => {
      const tools: ScorerTool[] = [{ function: { name: 'browser_navigate' } }];
      const matches = [match('click', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('should not crash when tool has no name and no function.name', () => {
      const tools: ScorerTool[] = [{ description: 'some tool' }];
      const result = detectSpecificity([], tools);
      expect(result).toBeNull();
    });

    it('should not crash when tool.function exists but has no name', () => {
      const tools: ScorerTool[] = [{ function: { description: 'x' } }];
      const result = detectSpecificity([], tools);
      expect(result).toBeNull();
    });

    it('should not crash when tool.function is undefined', () => {
      const tools: ScorerTool[] = [{ function: undefined }];
      const result = detectSpecificity([], tools);
      expect(result).toBeNull();
    });

    it('should handle case-insensitive tool name matching', () => {
      const tools: ScorerTool[] = [{ name: 'Browser_Navigate' }];
      const matches = [match('click', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('should skip tools with no matching prefix', () => {
      const tools: ScorerTool[] = [{ name: 'custom_tool' }];
      const result = detectSpecificity([], tools);
      expect(result).toBeNull();
    });

    it('should not apply heuristics when tools array is empty', () => {
      // With threshold=1, a single match now detects — use threshold=2 to test tool isolation
      const matches = [match('function', 'codeGeneration', 0)];
      const result = detectSpecificity(matches, [], undefined, 2);
      expect(result).toBeNull();
    });

    // For categories with threshold=1.0, a single tool-prefix match (TOOL_MATCH_WEIGHT=3)
    // is enough to activate on its own — no keyword matches required.
    it('should boost image_generation for image_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'image_generate' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('image_generation');
    });

    it('should boost image_generation for midjourney_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'midjourney_imagine' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('image_generation');
    });

    it('should boost image_generation for firefly_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'firefly_generate' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('image_generation');
    });

    it('should boost image_generation for leonardo_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'leonardo_generate' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('image_generation');
    });

    it('should boost video_generation for video_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'video_create' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('video_generation');
    });

    it('should boost video_generation for runway_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'runway_gen' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('video_generation');
    });

    it('should boost video_generation for sora_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'sora_generate' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('video_generation');
    });

    it('should boost social_media for social_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'social_post' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('social_media');
    });

    it('should boost social_media for hootsuite_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'hootsuite_schedule' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('social_media');
    });

    it('should boost social_media for buffer_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'buffer_post' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('social_media');
    });

    it('should boost email_management for email_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'email_send' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('email_management');
    });

    it('should boost email_management for gmail_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'gmail_send' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('email_management');
    });

    it('should boost email_management for outlook_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'outlook_send' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('email_management');
    });

    it('should boost email_management for superhuman_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'superhuman_send' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('email_management');
    });

    it('should boost calendar_management for calendar_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'calendar_create_event' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('calendar_management');
    });

    it('should boost calendar_management for gcal_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'gcal_create' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('calendar_management');
    });

    it('should boost calendar_management for calendly_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'calendly_book' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('calendar_management');
    });

    it('should boost calendar_management for reclaim_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'reclaim_schedule' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('calendar_management');
    });

    it('should boost trading for trade_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'trade_execute' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });

    it('should boost trading for exchange_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'exchange_order' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });

    it('should boost trading for robinhood_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'robinhood_buy' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });

    it('should boost trading for kalshi_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'kalshi_trade' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });

    it('should boost trading for coinbase_ prefixed tool', () => {
      const tools: ScorerTool[] = [{ name: 'coinbase_buy' }];
      const result = detectSpecificity([], tools);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });
  });

  describe('session stickiness (recentCategories)', () => {
    it('biases ambiguous current turn toward sticky recent category', () => {
      // An ambiguous message whose web_browsing signal would hit exactly the
      // threshold (3) — with the last 3 turns all coding, the session bias
      // (+2) keeps coding ahead. This is the discussion #1613 scenario.
      const matches = [
        match('visit', 'webBrowsing', 0), // weight 3 → web_browsing = 3
        match('function', 'codeGeneration', 10), // weight 1 → coding = 1
      ];
      const result = detectSpecificity(matches, undefined, undefined, undefined, undefined, [
        'coding',
        'coding',
        'coding',
      ]);
      expect(result).not.toBeNull();
      // Without stickiness, web_browsing wins (3 vs 1). With +2 stickiness on
      // coding, coding scores 3 — tied. We take the first to clear threshold
      // with the highest score, so web_browsing still wins on equal bestScore
      // thanks to comparison being strict `>`. This confirms stickiness alone
      // doesn't override a genuine anchor — it only biases close races.
      // Bumping coding by one more match flips it:
      const matches2 = [
        match('visit', 'webBrowsing', 0),
        match('function', 'codeGeneration', 10),
        match('class', 'codeGeneration', 20),
      ];
      const result2 = detectSpecificity(matches2, undefined, undefined, undefined, undefined, [
        'coding',
        'coding',
        'coding',
      ]);
      expect(result2!.category).toBe('coding');
    });

    it('ignores stickiness when current-turn anchor dominates', () => {
      // Strong anchor: navigate (3) + browse (3) = 6 web_browsing, clearly
      // above both the threshold and any sticky bias.
      const matches = [match('navigate', 'webBrowsing', 0), match('browse', 'webBrowsing', 10)];
      const result = detectSpecificity(matches, undefined, undefined, undefined, undefined, [
        'coding',
        'coding',
        'coding',
      ]);
      expect(result!.category).toBe('web_browsing');
    });

    it('requires at least 3 consistent recent categories to bias', () => {
      // Only 2 recent entries — below STICKY_AGREEMENT_MIN, so no bias applied.
      const matches = [match('visit', 'webBrowsing', 0), match('function', 'codeGeneration', 10)];
      const result = detectSpecificity(matches, undefined, undefined, undefined, undefined, [
        'coding',
        'coding',
      ]);
      expect(result!.category).toBe('web_browsing');
    });

    it('does not bias when recent categories disagree', () => {
      const matches = [match('visit', 'webBrowsing', 0), match('function', 'codeGeneration', 10)];
      const result = detectSpecificity(matches, undefined, undefined, undefined, undefined, [
        'coding',
        'web_browsing',
        'coding',
      ]);
      expect(result!.category).toBe('web_browsing');
    });
  });

  describe('category penalties', () => {
    it('subtracts the penalty from a flagged category so a weaker one wins', () => {
      const matches = [
        match('visit', 'webBrowsing', 0), // weight 3 → web_browsing = 3
        match('function', 'codeGeneration', 10), // weight 1 → coding = 1
      ];
      // A 2.5 penalty on web_browsing drops it to 0.5 — below threshold and
      // below coding. Coding at 1.0 wins.
      const penalties = new Map([['web_browsing' as const, 2.5]]);
      const result = detectSpecificity(
        matches,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        penalties,
      );
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('clamps the post-penalty score at zero', () => {
      // A huge penalty on the only category still leaves it at 0 (not negative),
      // so the detector returns null instead of selecting a sub-threshold score.
      const matches = [match('function', 'codeGeneration', 0)];
      const penalties = new Map([['coding' as const, 1000]]);
      const result = detectSpecificity(
        matches,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        penalties,
      );
      expect(result).toBeNull();
    });

    it('does not alter scores when the penalty map is empty', () => {
      const matches = [match('function', 'codeGeneration', 0)];
      const penalties = new Map();
      const result = detectSpecificity(
        matches,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        penalties,
      );
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });
  });

  describe('confidence calculation', () => {
    it('should compute confidence as score / (threshold * 3)', () => {
      const matches = [
        match('function', 'codeGeneration', 0),
        match('class', 'codeGeneration', 10),
        match('module', 'codeGeneration', 20),
      ];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      // score=3, threshold=1, confidence = min(3 / (1*3), 1.0) = 1.0
      expect(result!.confidence).toBe(1.0);
    });

    it('should cap confidence at 1.0 for high scores', () => {
      const matches: TrieMatch[] = [];
      for (let i = 0; i < 10; i++) {
        matches.push(match(`kw${i}`, 'codeGeneration', i * 10));
      }
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      // score=10, threshold=2, confidence = min(10/6, 1.0) = 1.0
      expect(result!.confidence).toBe(1.0);
    });

    it('should compute minimum confidence at threshold boundary', () => {
      const matches = [match('function', 'codeGeneration', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      // score=1, threshold=1, confidence = 1 / (1*3) = 0.333...
      expect(result!.confidence).toBeCloseTo(1 / 3, 5);
    });
  });

  describe('custom threshold parameter', () => {
    it('should detect with a lower threshold', () => {
      const matches = [match('function', 'codeGeneration', 0)];
      const result = detectSpecificity(matches, undefined, undefined, 1);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
      // score=1, threshold=1, confidence = 1 / (1*3) = 0.333...
      expect(result!.confidence).toBeCloseTo(1 / 3, 5);
    });

    it('should not detect when score is below custom threshold', () => {
      const matches = [
        match('function', 'codeGeneration', 0),
        match('class', 'codeGeneration', 10),
      ];
      const result = detectSpecificity(matches, undefined, undefined, 5);
      expect(result).toBeNull();
    });

    it('should still honor header override regardless of threshold', () => {
      const result = detectSpecificity([], undefined, 'coding', 100);
      expect(result).toEqual({ category: 'coding', confidence: 1.0 });
    });
  });

  describe('ACTIVATION_THRESHOLDS per-category boundaries', () => {
    // These tests exercise the REAL ACTIVATION_THRESHOLDS map (no override) to
    // pin the per-category activation floor. web_browsing is intentionally high
    // (3.0) vs every other category (1.0); regressions in those values would
    // silently change routing behavior.

    it('web_browsing requires score >= 3.0 to activate (real threshold)', () => {
      // 'navigate' has weight 3 → score = 3.0 exactly = threshold → activates.
      const matches = [match('navigate', 'webBrowsing', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('web_browsing does NOT activate at score 2.0 (below 3.0 threshold)', () => {
      // 'click the' has weight 2 → score = 2.0 < 3.0 → no activation.
      const matches = [match('click the', 'webBrowsing', 0)];
      const result = detectSpecificity(matches);
      expect(result).toBeNull();
    });

    it('web_browsing does NOT activate at score 1.5 (single weak noun)', () => {
      // 'website' has weight 1.5 → 1.5 < 3.0 → no activation.
      const matches = [match('website', 'webBrowsing', 0)];
      const result = detectSpecificity(matches);
      expect(result).toBeNull();
    });

    it('coding activates at score 1.0 (single default-weight match)', () => {
      // Unknown keyword → weight 1 → score = 1.0 = threshold → activates.
      const matches = [match('anything', 'codeGeneration', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('coding');
    });

    it('data_analysis activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'dataAnalysis', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('data_analysis');
    });

    it('image_generation activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'imageGeneration', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('image_generation');
    });

    it('video_generation activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'videoGeneration', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('video_generation');
    });

    it('social_media activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'socialMedia', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('social_media');
    });

    it('email_management activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'emailManagement', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('email_management');
    });

    it('calendar_management activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'calendarManagement', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('calendar_management');
    });

    it('trading activates at score 1.0 (single default-weight match)', () => {
      const matches = [match('anything', 'trading', 0)];
      const result = detectSpecificity(matches);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('trading');
    });

    it('thresholdOverride uniformly raises the bar for every category', () => {
      // Override of 4 — coding match (1.0) and web_browsing strong anchor (3.0)
      // both fall below, so no category activates.
      const matches = [
        match('function', 'codeGeneration', 0),
        match('navigate', 'webBrowsing', 10),
      ];
      const result = detectSpecificity(matches, undefined, undefined, 4);
      expect(result).toBeNull();
    });

    it('thresholdOverride applies the >= comparison at the exact boundary', () => {
      // Score = 3.0 (from 'navigate'); override = 3.0; should activate.
      const matches = [match('navigate', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, undefined, undefined, 3);
      expect(result).not.toBeNull();
      expect(result!.category).toBe('web_browsing');
    });

    it('thresholdOverride just above score does not activate', () => {
      // Score = 3.0 (from 'navigate'); override = 3.01 → 3.0 < 3.01 → null.
      const matches = [match('navigate', 'webBrowsing', 0)];
      const result = detectSpecificity(matches, undefined, undefined, 3.01);
      expect(result).toBeNull();
    });
  });
});
