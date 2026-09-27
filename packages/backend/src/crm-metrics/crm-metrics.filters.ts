/**
 * Deliverability filtering for the CRM feed.
 *
 * These run here rather than in the CRM so every consumer inherits them: an
 * address excluded once is excluded everywhere, and the rules stay under test.
 *
 * The known bot-signup cluster (gibberish names on scraped corporate domains)
 * deliberately has no rule. It never produced a successful heal, so the cohort
 * predicate already excludes it — a domain list would be dead code that rots.
 */

/** Our own addresses. Emailing ourselves about our own launch is noise. */
const INTERNAL_DOMAINS = ['manifest.build', 'buddyweb.fr', 'mnfstinc.com', 'mnfstinc.dev'];

/** Team members signed up on a personal address, so the domain rule misses them. */
const INTERNAL_EMAILS = ['sebastien.conejo@gmail.com'];

/**
 * Disposable/alias providers. Mirrors the list the CRM outreach function
 * already carries, so both sides agree on what counts as junk.
 */
const JUNK_DOMAINS = [
  'slmail.me',
  'atomicmail.io',
  'paytrust.cc',
  'rapplo.com',
  'joystill.com',
  'abrdns.com',
  'cryptidcloud.org',
  'dralias.com',
  'mail.cfw.262019.xyz',
];

/** Shared inboxes: nobody in particular reads these, and they skew reply rates. */
const ROLE_LOCAL_PARTS = [
  'info',
  'admin',
  'contact',
  'support',
  'sales',
  'marketing',
  'office',
  'team',
  'noreply',
  'no-reply',
  'test',
];

/**
 * True when we should not email this address.
 *
 * Subdomains of a junk domain count as junk (`x.dralias.com`), but a domain
 * that merely ends with the same letters does not (`notdralias.com`).
 */
export function isExcludedEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  // No '@' at all, or an empty local part / domain: not a routable address.
  if (at <= 0 || at === normalized.length - 1) return true;

  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);

  if (INTERNAL_EMAILS.includes(normalized)) return true;
  if (matchesDomain(domain, INTERNAL_DOMAINS)) return true;
  if (matchesDomain(domain, JUNK_DOMAINS)) return true;
  return ROLE_LOCAL_PARTS.includes(local);
}

function matchesDomain(domain: string, list: string[]): boolean {
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

/**
 * Consumer mail and privacy-relay providers.
 *
 * Separate from JUNK_DOMAINS because these addresses are perfectly real — the
 * healed-user feed emails plenty of them. They are excluded from the *signup*
 * feed only, where the whole premise is "a corporate domain implies a team
 * behind it". A gmail.com signup carries no such signal.
 *
 * The relay entries matter more than the obvious freemail ones: duck.com,
 * pm.me and simplelogin addresses read as custom domains to a naive
 * `not freemail` check, and were the largest "corporate" domains in the
 * database by signup count until they were listed here.
 */
const CONSUMER_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.fr',
  'hotmail.com',
  'hotmail.fr',
  'hotmail.co.uk',
  'live.com',
  'live.fr',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'duck.com',
  'simplelogin.com',
  'simplelogin.io',
  'anonaddy.com',
  'posteo.de',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'free.fr',
  'orange.fr',
  'wanadoo.fr',
  'laposte.net',
  'sfr.fr',
  'comcast.net',
  'qq.com',
  '163.com',
  '126.com',
  'foxmail.com',
  'sina.com',
  'naver.com',
  'daum.net',
  'yandex.ru',
  'yandex.com',
  'mail.com',
  'mail.ru',
  'rambler.ru',
  'seznam.cz',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'engineer.com',
  'consultant.com',
  'usa.com',
  'europe.com',
  'bk.ru',
  'list.ru',
  'inbox.ru',
  'inbox.lv',
  'email.com',
  'email.cz',
  'example.com',
  'test.com',
];

/**
 * Consumer providers with country variants, matched as a family.
 *
 * An exact list cannot keep up: the first live run of the signup feed let
 * through yahoo.de, yahoo.com.br, outlook.de, bk.ru, tuta.io and thirty more
 * that were simply not enumerated. The brand followed by a 2-3 letter TLD and
 * an optional two-letter country suffix covers the whole family — `yahoo.de`,
 * `yahoo.com.br`, `yahoo.co.jp` — without touching `mail.acme.com`, whose
 * second label is not a TLD.
 *
 * Matched at a label boundary, not only at the start, so `mail.yahoo.de` and
 * `imap.gmx.net` count too.
 *
 * Only brands that are consumer mail on *every* TLD belong here. Names that
 * are also a real company's domain — comcast.com, orange.com, web.com,
 * free.fr vs free.com, mail.com vs mail.acme.com — stay in the exact list
 * for their consumer TLDs, so a corporate signup at orange.com is kept.
 */
const CONSUMER_FAMILIES = new RegExp(
  '(?:^|\\.)(?:' +
    [
      'gmail',
      'googlemail',
      'yahoo',
      'ymail',
      'rocketmail',
      'outlook',
      'hotmail',
      'live',
      'msn',
      'aol',
      'icloud',
      'proton',
      'protonmail',
      'tuta',
      'tutanota',
      'tutamail',
      'gmx',
      'yandex',
      'rambler',
      'disroot',
      'posteo',
      'mailbox',
      'riseup',
      'zoho',
      'fastmail',
      'qq',
      'foxmail',
      'naver',
      'daum',
      'seznam',
      'laposte',
      'wanadoo',
    ].join('|') +
    ')\\.[a-z]{2,3}(?:\\.[a-z]{2})?$',
);

/**
 * Privacy relays and disposable inboxes seen in production signups. Real
 * people, but the address is not an organisation's and often not even a
 * lasting one. Kept separate from CONSUMER_DOMAINS so the two lists say what
 * they are.
 */
const RELAY_AND_DISPOSABLE_DOMAINS = [
  'privaterelay.appleid.com',
  'passinbox.com',
  'passmail.net',
  'passmail.com',
  'passfwd.com',
  'mozmail.com',
  'relay.firefox.com',
  'addy.io',
  'anonaddy.me',
  'simplelogin.co',
  'simplelogin.fr',
  'startmail.com',
  'sharklasers.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'grr.la',
  'yopmail.com',
  'harakirimail.com',
  'tempmail10.com',
  'mailinator.com',
  'agentmail.to',
  'maildrop.cc',
  'getnada.com',
  'dispostable.com',
  'trashmail.com',
  '10minutemail.com',
];

/**
 * Universities. `.edu`, `.edu.xx` and `.ac.xx` cover every national scheme
 * seen in production (Bangladesh, India, Korea, Taiwan, the UK, Indonesia,
 * Vietnam, Brazil…). A student is a real person with a real address, but not
 * the "team behind a corporate domain" this feed exists to find.
 *
 * The country part is exactly two letters. `{2,3}` would also take
 * `company.edu.com` and `startup.ac.dev`, which are companies.
 */
const ACADEMIC_DOMAIN = /(?:^|\.)(?:edu|ac)\.[a-z]{2}$|\.edu$/;

/** Signups on one domain inside this span, with no traffic, look scripted. */
const CLUSTER_WINDOW_MS = 30 * 86_400_000;

/** Fewer than this on a domain is a small team, not a cluster. */
const CLUSTER_MIN_SIGNUPS = 3;

/** The domain part of an address, lowercased; empty when unroutable. */
export function domainOf(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return '';
  return normalized.slice(at + 1);
}

/**
 * True when the address does not belong to an organisation: a consumer
 * mailbox (exact list or brand family), a privacy relay or disposable inbox,
 * or a university.
 *
 * Subdomains count (`mail.duck.com`), matching `isExcludedEmail`.
 */
export function isConsumerEmail(email: string): boolean {
  const domain = domainOf(email);
  if (!domain) return true;
  return (
    matchesDomain(domain, CONSUMER_DOMAINS) ||
    matchesDomain(domain, RELAY_AND_DISPOSABLE_DOMAINS) ||
    CONSUMER_FAMILIES.test(domain) ||
    ACADEMIC_DOMAIN.test(domain)
  );
}

/**
 * The signup feed's admission rule: a routable address, on a domain that looks
 * like an organisation, that we are not already excluding for other reasons.
 */
export function isCorporateSignupEmail(email: string): boolean {
  return !isExcludedEmail(email) && !isConsumerEmail(email);
}

/** One signup, reduced to what the cluster rule needs to judge a domain. */
export interface ClusterCandidate {
  signed_up_at: string;
  has_traffic: boolean;
}

/**
 * True when a domain's signups look automated rather than like a real team.
 *
 * Three or more accounts, created inside a month, none of which ever sent a
 * request. A genuine team trickles in over quarters and at least one of them
 * points something at the gateway; the scraped-address clusters we have seen
 * arrive in a burst and never call the API.
 *
 * Any traffic at all clears the whole domain: a real user among them means the
 * burst was a launch, not a script.
 */
export function isSignupCluster(signups: ClusterCandidate[]): boolean {
  if (signups.length < CLUSTER_MIN_SIGNUPS) return false;
  if (signups.some((signup) => signup.has_traffic)) return false;

  const times = signups
    .map((signup) => new Date(signup.signed_up_at).getTime())
    .sort((a, b) => a - b);
  return times[times.length - 1] - times[0] <= CLUSTER_WINDOW_MS;
}

/**
 * The local-part shape temp-mail generators produce: a run of letters and a
 * run of digits, nothing else. `lidosej357`, `xiyese3594`, `gimade8897`.
 *
 * Real people use it too (`john1985`), so it is never judged one address at
 * a time — only when every address on a domain has the shape, below.
 */
const MACHINE_LOCAL_PART = /^[a-z]{4,8}[0-9]{3,6}$/;

/**
 * True when a domain's signups all look machine-generated.
 *
 * Two or more accounts, every one of them a letters-then-digits local part.
 * A company does not sign up its whole team as `vatiy14692@` and
 * `xiyese3594@`; a disposable-mail domain does nothing else. On the first
 * dry run this was aratrin.com and lidugw.com — with Faker names attached,
 * and with traffic, so the quiet-cluster rule above did not fire.
 *
 * Across every verified signup this matched four domains: those two,
 * mypethealh.com, and one university whose student ids happen to fit and
 * which the academic rule already removes.
 */
export function isMachineGeneratedDomain(localParts: string[]): boolean {
  return localParts.length >= 2 && localParts.every((local) => MACHINE_LOCAL_PART.test(local));
}
