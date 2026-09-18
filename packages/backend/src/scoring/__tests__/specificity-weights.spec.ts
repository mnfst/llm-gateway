import { ACTIVATION_THRESHOLDS, KEYWORD_WEIGHTS, weightFor } from '../specificity-weights';

describe('weightFor', () => {
  describe('returns correct weight for known keywords', () => {
    it('returns 4 for strong anchor "navigate to"', () => {
      expect(weightFor('navigate to')).toBe(4);
    });

    it('returns 4 for "scrape"', () => {
      expect(weightFor('scrape')).toBe(4);
    });

    it('returns 4 for "crawl"', () => {
      expect(weightFor('crawl')).toBe(4);
    });

    it('returns 4 for "open url"', () => {
      expect(weightFor('open url')).toBe(4);
    });

    it('returns 4 for "take a screenshot"', () => {
      expect(weightFor('take a screenshot')).toBe(4);
    });

    it('returns 3 for "browse"', () => {
      expect(weightFor('browse')).toBe(3);
    });

    it('returns 3 for "visit"', () => {
      expect(weightFor('visit')).toBe(3);
    });

    it('returns 3 for "navigate"', () => {
      expect(weightFor('navigate')).toBe(3);
    });

    it('returns 3 for "go to"', () => {
      expect(weightFor('go to')).toBe(3);
    });

    it('returns 3 for context phrase "this website"', () => {
      expect(weightFor('this website')).toBe(3);
    });

    it('returns 3 for "this page"', () => {
      expect(weightFor('this page')).toBe(3);
    });

    it('returns 2 for "this domain"', () => {
      expect(weightFor('this domain')).toBe(2);
    });

    it('returns 2 for "click on"', () => {
      expect(weightFor('click on')).toBe(2);
    });

    it('returns 2 for "webpage"', () => {
      expect(weightFor('webpage')).toBe(2);
    });

    it('returns 1.5 for weak noun "website"', () => {
      expect(weightFor('website')).toBe(1.5);
    });

    it('returns 1.5 for "web page"', () => {
      expect(weightFor('web page')).toBe(1.5);
    });
  });

  describe('returns 1.0 fallback for unknown keywords', () => {
    it('returns 1 for completely unknown keyword', () => {
      expect(weightFor('unknown-keyword-xyz')).toBe(1);
    });

    it('returns 1 for empty string', () => {
      expect(weightFor('')).toBe(1);
    });

    it('returns 1 for arbitrary phrase not in map', () => {
      expect(weightFor('plot a chart')).toBe(1);
    });

    it('returns 1 for a single word not in map', () => {
      expect(weightFor('refactor')).toBe(1);
    });

    it('returns 1 for keyword that looks similar but has different spacing', () => {
      expect(weightFor('navigateto')).toBe(1);
    });
  });

  describe('is case-sensitive', () => {
    it('does not match "Navigate To" (titlecase)', () => {
      expect(weightFor('Navigate To')).toBe(1);
      expect(weightFor('Navigate To')).not.toBe(4);
    });

    it('does not match "BROWSE" (uppercase)', () => {
      expect(weightFor('BROWSE')).toBe(1);
      expect(weightFor('BROWSE')).not.toBe(3);
    });

    it('does not match "Website" (titlecase)', () => {
      expect(weightFor('Website')).toBe(1);
      expect(weightFor('Website')).not.toBe(1.5);
    });

    it('does not match "Scrape" (titlecase)', () => {
      expect(weightFor('Scrape')).toBe(1);
    });
  });

  describe('does not match keywords with leading/trailing whitespace', () => {
    it('returns 1 for " navigate to" (leading space)', () => {
      expect(weightFor(' navigate to')).toBe(1);
    });

    it('returns 1 for "browse " (trailing space)', () => {
      expect(weightFor('browse ')).toBe(1);
    });
  });

  describe('weight tiers reflect spec', () => {
    it('strong anchors (4) outweigh strong verbs (3)', () => {
      expect(weightFor('navigate to')).toBeGreaterThan(weightFor('navigate'));
    });

    it('strong verbs (3) outweigh medium context (2)', () => {
      expect(weightFor('browse')).toBeGreaterThan(weightFor('click on'));
    });

    it('medium context (2) outweighs weak nouns (1.5)', () => {
      expect(weightFor('click on')).toBeGreaterThan(weightFor('website'));
    });

    it('weak nouns (1.5) outweigh the unknown fallback (1)', () => {
      expect(weightFor('website')).toBeGreaterThan(weightFor('not-a-real-keyword'));
    });
  });

  describe('map integrity', () => {
    it('every key in KEYWORD_WEIGHTS resolves via weightFor', () => {
      for (const [keyword, weight] of Object.entries(KEYWORD_WEIGHTS)) {
        expect(weightFor(keyword)).toBe(weight);
      }
    });

    it('all weights are positive numbers', () => {
      for (const weight of Object.values(KEYWORD_WEIGHTS)) {
        expect(typeof weight).toBe('number');
        expect(weight).toBeGreaterThan(0);
        expect(Number.isFinite(weight)).toBe(true);
      }
    });

    it('all keys are non-empty strings', () => {
      for (const keyword of Object.keys(KEYWORD_WEIGHTS)) {
        expect(typeof keyword).toBe('string');
        expect(keyword.length).toBeGreaterThan(0);
      }
    });

    it('all keys are lowercased (case-sensitive lookup contract)', () => {
      for (const keyword of Object.keys(KEYWORD_WEIGHTS)) {
        expect(keyword).toBe(keyword.toLowerCase());
      }
    });
  });

  describe('spot-check anchor phrases from KEYWORD_WEIGHTS', () => {
    const anchorSamples: Array<[string, number]> = [
      ['navigate to', 4],
      ['browse to', 4],
      ['scrape', 4],
      ['crawl', 4],
      ['open url', 4],
      ['fetch url', 4],
      ['fetch the url', 4],
      ['take a screenshot', 4],
      ['web search', 4],
      ['bookmark this', 4],
      ['fill out the form', 4],
      ['browse', 3],
      ['visit', 3],
      ['this website', 3],
      ['this webpage', 3],
      ['this site', 3],
      ['this url', 3],
      ['on this page', 3],
      ['this page', 3],
      ['this domain', 2],
      ['open the url', 2],
      ['click the', 2],
      ['screenshot of', 2],
      ['webpage', 2],
      ['website', 1.5],
      ['web page', 1.5],
      // private_docs anchors
      ['hipaa', 3],
      ['pii', 3],
      ['medical record', 3],
      ['attorney-client privilege', 3],
    ];

    it.each(anchorSamples)('weightFor(%j) === %s', (keyword, expectedWeight) => {
      expect(weightFor(keyword)).toBe(expectedWeight);
    });
  });

  /**
   * Bare single-word tokens that collide with coding / science vocabulary
   * (math.phi, the SoX audio library, biopython MSA, "network dynamic
   * affinity", a React soc2 badge, "this document is confidential") must NOT
   * be decisive on their own. They are demoted below the 1.0 activation
   * threshold so a single occurrence cannot flip routing to private_docs; the
   * unambiguous privacy acronyms (hipaa, pii, gdpr, ccpa, pdpa) stay strong.
   * See the review finding on private-docs.ts:32.
   */
  describe('collisioning bare tokens are sub-threshold', () => {
    const SUB_THRESHOLD = [
      'phi',
      'sox',
      'msa',
      'nda',
      'soc2',
      'confidential',
      'diagnosis',
      'prescription',
      'testimony',
    ];
    it.each(SUB_THRESHOLD)('%j weighs less than the private_docs threshold (1.0)', (kw) => {
      expect(weightFor(kw)).toBeLessThan(1.0);
    });

    it('unambiguous privacy acronyms stay strong (weight 3)', () => {
      for (const kw of ['hipaa', 'pii', 'gdpr', 'ccpa', 'pdpa']) {
        expect(weightFor(kw)).toBe(3);
      }
    });
  });
});

describe('ACTIVATION_THRESHOLDS', () => {
  it('web_browsing threshold (3) matches the strong-anchor weight tier', () => {
    expect(ACTIVATION_THRESHOLDS.web_browsing).toBe(3);
  });

  it('all non-web_browsing categories use the 1.0 threshold', () => {
    expect(ACTIVATION_THRESHOLDS.coding).toBe(1);
    expect(ACTIVATION_THRESHOLDS.data_analysis).toBe(1);
    expect(ACTIVATION_THRESHOLDS.image_generation).toBe(1);
    expect(ACTIVATION_THRESHOLDS.video_generation).toBe(1);
    expect(ACTIVATION_THRESHOLDS.social_media).toBe(1);
    expect(ACTIVATION_THRESHOLDS.email_management).toBe(1);
    expect(ACTIVATION_THRESHOLDS.calendar_management).toBe(1);
    expect(ACTIVATION_THRESHOLDS.trading).toBe(1);
    expect(ACTIVATION_THRESHOLDS.private_docs).toBe(1);
  });

  it('web_browsing threshold is the highest of all categories', () => {
    const webBrowsing = ACTIVATION_THRESHOLDS.web_browsing;
    for (const [category, threshold] of Object.entries(ACTIVATION_THRESHOLDS)) {
      if (category !== 'web_browsing') {
        expect(threshold).toBeLessThanOrEqual(webBrowsing);
      }
    }
  });

  it('every threshold is a positive finite number', () => {
    for (const threshold of Object.values(ACTIVATION_THRESHOLDS)) {
      expect(typeof threshold).toBe('number');
      expect(threshold).toBeGreaterThan(0);
      expect(Number.isFinite(threshold)).toBe(true);
    }
  });

  it('contains an entry for every documented specificity category', () => {
    const expected = [
      'coding',
      'web_browsing',
      'data_analysis',
      'image_generation',
      'video_generation',
      'social_media',
      'email_management',
      'calendar_management',
      'trading',
      'private_docs',
    ];
    for (const key of expected) {
      expect(ACTIVATION_THRESHOLDS).toHaveProperty(key);
    }
  });
});
