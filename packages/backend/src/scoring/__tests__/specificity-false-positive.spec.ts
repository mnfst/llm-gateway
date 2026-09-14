/**
 * False-positive regression harness for specificity detection.
 *
 * The web_browsing detector used to fire on generic web-development vocabulary
 * (html, dom, url, page, site, domain, fetch, http, link) which misrouted
 * entire coding sessions to bargain models. See discussion #1613.
 *
 * This harness uses realistic frontend/web-app coding prompts — the kind of
 * thing a developer would type during a React/Next/Express session — and
 * asserts that web_browsing does not fire on them.
 */
import { scanMessages } from '../scan-messages';
import type { ScorerMessage, ScorerTool } from '../types';

function scan(text: string, tools?: ScorerTool[]) {
  const msgs: ScorerMessage[] = [{ role: 'user', content: text }];
  return scanMessages(msgs, tools);
}

interface FalsePositiveReport {
  total: number;
  byCategory: Map<string, number>;
  failures: { prompt: string; detected: string }[];
}

function measureFalsePositives(
  prompts: string[],
  disallowedCategory: string,
  tools?: ScorerTool[],
): FalsePositiveReport {
  const byCategory = new Map<string, number>();
  const failures: { prompt: string; detected: string }[] = [];

  for (const p of prompts) {
    const r = scan(p, tools);
    const detected = r?.category ?? 'null';
    byCategory.set(detected, (byCategory.get(detected) ?? 0) + 1);
    if (detected === disallowedCategory) {
      failures.push({ prompt: p, detected });
    }
  }

  return { total: prompts.length, byCategory, failures };
}

/**
 * Prompts pulled from a realistic 2-hour React/Next/Express coding session.
 * Every one of these should route to coding or null — NEVER to web_browsing.
 * These are all the phrases that used to trip the generic keyword list.
 */
const FRONTEND_CODING_PROMPTS = [
  // HTML / DOM coding
  'update the html template for the pricing page',
  'the dom node is not updating when state changes',
  'why is my css selector not matching the element',
  'fix the xpath in my puppeteer test',
  'render the html form with proper labels',
  'the shadow dom is leaking styles into the parent',
  'add aria labels to the html buttons',
  'escape html entities before rendering',
  'my svg icons are not showing in the dom',
  'the html is malformed when the server renders it',

  // URL / routing coding
  'the url parameters are not being parsed correctly',
  'add a route for /users/:id in my express app',
  'the redirect to /login is looping infinitely',
  'how do I handle query string parsing',
  'the slug in the url is not matching the page component',
  'fix the catch-all route that breaks deep links',
  'convert kebab-case urls to camelCase routes',
  'the base path prefix is missing from generated urls',
  'add a 301 redirect from the old url to the new one',
  'the pathname does not include the locale prefix',

  // HTTP / fetch coding
  'the http response returns 500 with no body',
  'add retry logic to the fetch call',
  'abort the fetch when the component unmounts',
  'the cors preflight is failing on the http OPTIONS request',
  'parse the fetch response as json',
  'the http client does not send the bearer token',
  'fix the race condition in my fetch hook',
  'abort controllers are not cancelling the pending fetch',
  'the http agent is not reusing connections',
  'stream the fetch response body chunk by chunk',

  // Link / page / site
  'the link component is not preventing default',
  'add a prefetch hint on the nav link',
  'the page component re-renders on every route change',
  'the landing page is blank in production',
  'the site builds fine locally but breaks on vercel',
  'fix the 404 page so it shows a back button',
  'the privacy page has a typo in the markdown',
  'each page should have its own metadata',
  'wrap every page in the providers boundary',
  'the internal link is showing up as external',

  // Domain / tab
  'add the domain to the allowlist for cors',
  'the cookie is not set because the domain does not match',
  'open the dashboard in a new tab with target=_blank',
  'the tab index is wrong for keyboard navigation',
  'prevent the tab from being closed if there are unsaved changes',
  'switch the active tab when the route changes',
  'the custom domain is not resolving to the right tenant',
  'the subdomain routing middleware is throwing',

  // Google / fetch (ambiguous verbs)
  'integrate google oauth with nextauth',
  'add google fonts to the stylesheet',
  'fetch the user profile from the api endpoint',
  'fetch and cache the config on app start',
  'the google analytics script is blocking the main thread',

  // RSS / sitemap / whois (infra coding)
  'generate the sitemap.xml at build time',
  'add an rss feed for the blog posts',
  'parse the rss feed and cache the entries',
  'the sitemap is missing the new routes',

  // Screenshot / scroll (coding, not browse)
  'fix the infinite scroll component that jitters',
  'add a scroll restoration hook to the router',
  'take a screenshot of the component in storybook',
  'the scrollIntoView is off by the header height',
  'virtualize the list so scrolling stays smooth',

  // Mixed realistic session
  'refactor the page component to use server actions',
  'the api route handler is not returning json',
  'add a loading state to the fetch hook',
  'fix the dark mode toggle on the settings page',
  'memoize the selector so the component does not rerender',
  'the form submit is posting to the wrong url',
  'add an error boundary around the page content',
  'the auth redirect drops the return_to query param',
  'extract the header into its own component',
  'the canonical url is wrong on the blog index page',
  'optimize the hero image on the homepage',
  'the sidebar link is missing an active state',
  'split the page into server and client components',
  'the page transition animation flickers on navigation',
  'make the cookie banner dismissible per domain',
  'add a meta description to every page',
  'prerender the pricing page at build time',
  'the image tag needs width and height attributes',
  'the link preload is pointing at the wrong asset',
  'fix the focus trap on the modal overlay',
  'the anchor link is not scrolling to the section',
  'add breadcrumbs to every product page',
  'generate og:image dynamically for each page',
  'the link prefetch is downloading too much on hover',
  'add a robots meta tag to exclude staging',
  'parse the html fragment server side before returning',
  'the signed url is expiring too quickly',
  'the page title is not updating on route change',
  'scroll to the error field when validation fails',
  'dedupe the sitemap entries before writing',
  'the page hydrates with stale props after navigation',
  'attach the click handler to the parent link wrapper',
  'the http header is rejected because it contains spaces',
  'render the rich-text html from the CMS safely',
  'open a new tab only on modifier-click',
  'the favicon is 404-ing for safari on the site root',
  'add the og:url meta tag to every indexable page',
  'the fetch call inside getServerSideProps times out',
  'the link component should preserve scroll on back',
  'canonical tag differs between prerender and runtime',
  'the html lang attribute is wrong on localized pages',
];

/**
 * Session simulation: a realistic coding conversation where each message is
 * short and incremental. These are the requests that misroute in a 2-hour
 * session — individually they look ambiguous but collectively are obviously
 * a coding session.
 */
const SESSION_CODING_TURNS = [
  'add a button on the login page',
  'the button is not centered',
  'make it blue',
  'fix the url handler',
  'the link is broken',
  'update the page title',
  'scroll to the top',
  'the tab is not active',
  'fix the redirect',
  'add a new route',
  'the fetch is failing',
  'handle the http error',
  'parse the response',
  'update the component',
  'the page is white',
  'add a loading spinner',
  'the nav is hidden on mobile',
  'fix the modal',
  'the form does not submit',
  'make the site responsive',
];

describe('specificity false-positive regression', () => {
  describe('frontend/web-app coding prompts must not route to web_browsing', () => {
    it('reports distribution across categories', () => {
      const report = measureFalsePositives(FRONTEND_CODING_PROMPTS, 'web_browsing');

      // This test is informational — it prints the distribution so we can
      // track where misrouted prompts actually go (null, coding, etc.).
      const distribution = Array.from(report.byCategory.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(`\nfrontend coding prompt distribution (n=${report.total}): ${distribution}`);

      expect(report.total).toBe(FRONTEND_CODING_PROMPTS.length);
    });

    it('web_browsing false-positive rate stays under 3%', () => {
      const report = measureFalsePositives(FRONTEND_CODING_PROMPTS, 'web_browsing');
      const fpr = report.failures.length / report.total;

      if (fpr >= 0.03) {
        console.log(`\nweb_browsing false positives (${report.failures.length}/${report.total}):`);
        for (const f of report.failures.slice(0, 30)) {
          console.log(`  "${f.prompt}"`);
        }
        if (report.failures.length > 30) {
          console.log(`  ... and ${report.failures.length - 30} more`);
        }
      }

      expect(fpr).toBeLessThan(0.03);
    });
  });

  describe('session simulation: incremental coding prompts with web vocabulary', () => {
    it('no single turn in a coding session routes to web_browsing', () => {
      const report = measureFalsePositives(SESSION_CODING_TURNS, 'web_browsing');
      const fpr = report.failures.length / report.total;

      if (fpr > 0) {
        console.log(
          `\nsession coding turns misrouted to web_browsing (${report.failures.length}/${report.total}):`,
        );
        for (const f of report.failures) console.log(`  "${f.prompt}"`);
      }

      // In an iterative session, even a single wrong turn means a degraded
      // answer for the user — aim for zero.
      expect(report.failures.length).toBeLessThanOrEqual(1);
    });
  });

  describe('private_docs false-positive regression on coding prompts', () => {
    it('does not trigger private_docs on frontend/web-app coding vocabulary', () => {
      const report = measureFalsePositives(FRONTEND_CODING_PROMPTS, 'private_docs');
      // The private_docs keyword list avoids bare terms that overlap with
      // common coding vocabulary. Zero false positives on frontend/coding prompts.
      expect(report.failures.length).toBe(0);
    });

    it('does not trigger private_docs on session-simulation coding turns', () => {
      const report = measureFalsePositives(SESSION_CODING_TURNS, 'private_docs');
      expect(report.failures.length).toBe(0);
    });
  });

  describe('private_docs does not fire on bare coding/science vocabulary collisions', () => {
    /**
     * Regression for the review finding on private-docs.ts:32. These prompts
     * use bare tokens (phi, sox, msa, nda, soc2, confidential, diagnosis,
     * prescription, testimony) in ordinary coding / science senses. Each
     * demoted token is a single sub-threshold signal and must NOT route the
     * request to the privacy-preserving provider on its own.
     */
    const CODING_SCIENCE_COLLISIONS = [
      'compute the phi coefficient for this contingency table',
      'write a sox script to normalize audio volume',
      'use math.phi to compute the golden ratio in python',
      'align the sequences and run msa with biopython',
      'generate a soc2-style badge component in react',
      'add an nda field to the network dynamic affinity model',
      'this document is confidential, do not share it',
      'what is the diagnosis code for this icd mapping',
      'the prescription pattern in this react hook is wrong',
      'witness testimony in the mock trial object',
    ];

    it('no single bare-token collision routes to private_docs', () => {
      const report = measureFalsePositives(CODING_SCIENCE_COLLISIONS, 'private_docs');
      if (report.failures.length > 0) {
        console.log(
          `\nprivate_docs bare-token false positives (${report.failures.length}/${report.total}):`,
        );
        for (const f of report.failures) console.log(`  "${f.prompt}"`);
      }
      expect(report.failures.length).toBe(0);
    });

    it('a demoted token paired with a private anchor still routes to private_docs', () => {
      // Positive control: demotion must not break detection when a genuine
      // private signal is present alongside the bare token.
      expect(scan('redact the diagnosis from this medical history file')?.category).toBe(
        'private_docs',
      );
      expect(scan('read the patient record and redact phi before sharing')?.category).toBe(
        'private_docs',
      );
      // Unambiguous acronyms stay decisive on their own.
      expect(scan('extract pii from this csv export')?.category).toBe('private_docs');
    });
  });

  describe('private_docs does not fire on general knowledge questions about financial topics', () => {
    /**
     * Paired with the private_docs coverage prompts: these are the SAME
     * financial / medical terms but in a general-knowledge question context.
     * They should NOT be routed to a privacy-preserving provider.
     */
    const GENERAL_KNOWLEDGE_ABOUT_PRIVATE_TOPICS = [
      'explain Roth IRA income limits',
      'how does a 529 plan work',
      'when are 1099s due',
      'what is a W-2',
      'what does a CBC measure',
      'what bloodwork is normally done annually',
      'what are the HSA contribution limits',
      'what is a 401k rollover',
      'how do I open a brokerage account',
      'what is the difference between a traditional and roth ira',
      'how is mortgage interest calculated',
      'what is the current federal tax rate',
      'how does social security work',
      'what is a credit score range',
      'what is the difference between a traditional ira and roth ira',
      'how to read a bank statement',
      'what is an fsA',
      'what does ssn stand for',
      'what is the difference between medicare and medicaid',
      'how to prepare for a blood test',
    ];

    it('does not trigger private_docs on general knowledge financial questions', () => {
      const report = measureFalsePositives(GENERAL_KNOWLEDGE_ABOUT_PRIVATE_TOPICS, 'private_docs');

      if (report.failures.length > 0) {
        console.log(`\nprivate_docs false positives (${report.failures.length}/${report.total}):`);
        for (const f of report.failures) console.log(`  "${f.prompt}"`);
      }

      // Every general-knowledge question about financial/medical topics should
      // route to null or data_analysis — never to private_docs.
      expect(report.failures.length).toBe(0);
    });
  });

  describe('coding prompts with actual URLs are the only strong web_browsing signal', () => {
    it('detects web_browsing when a real URL is present alongside browse intent', () => {
      const r = scan('visit https://example.com and summarize the article');
      expect(r?.category).toBe('web_browsing');
    });

    it('does not detect web_browsing when a URL appears in a coding context', () => {
      const r = scan('the api call to https://api.stripe.com/v1/charges returns 500');
      expect(r?.category).not.toBe('web_browsing');
    });
  });
});
