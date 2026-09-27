import {
  domainOf,
  isConsumerEmail,
  isCorporateSignupEmail,
  isExcludedEmail,
  isMachineGeneratedDomain,
  isSignupCluster,
} from './crm-metrics.filters';

describe('isExcludedEmail', () => {
  it('keeps an ordinary user address', () => {
    expect(isExcludedEmail('matheus@example.com')).toBe(false);
    expect(isExcludedEmail('someone@gmail.com')).toBe(false);
  });

  it('excludes our own domains', () => {
    expect(isExcludedEmail('bruno@buddyweb.fr')).toBe(true);
    expect(isExcludedEmail('hello@manifest.build')).toBe(true);
    expect(isExcludedEmail('x@mnfstinc.com')).toBe(true);
  });

  it('excludes team members signed up on a personal address', () => {
    expect(isExcludedEmail('sebastien.conejo@gmail.com')).toBe(true);
  });

  it('excludes disposable and alias providers', () => {
    expect(isExcludedEmail('improving_poison241@dralias.com')).toBe(true);
    expect(isExcludedEmail('app.manifest.build@cryptidcloud.org')).toBe(true);
    expect(isExcludedEmail('a@slmail.me')).toBe(true);
  });

  it('excludes shared role inboxes', () => {
    expect(isExcludedEmail('info@realcompany.com')).toBe(true);
    expect(isExcludedEmail('no-reply@realcompany.com')).toBe(true);
    expect(isExcludedEmail('test@realcompany.com')).toBe(true);
  });

  it('matches a role inbox on the whole local part, not as a prefix', () => {
    expect(isExcludedEmail('information@realcompany.com')).toBe(false);
    expect(isExcludedEmail('admin.jones@realcompany.com')).toBe(false);
    expect(isExcludedEmail('contact-us@realcompany.com')).toBe(false);
  });

  it('treats subdomains of a junk domain as junk', () => {
    expect(isExcludedEmail('a@mail.dralias.com')).toBe(true);
  });

  it('does not match a domain that merely ends with the same letters', () => {
    expect(isExcludedEmail('a@notdralias.com')).toBe(false);
    expect(isExcludedEmail('a@notmanifest.build')).toBe(false);
  });

  it('normalises case and surrounding whitespace before matching', () => {
    expect(isExcludedEmail('  Bruno@BuddyWeb.FR  ')).toBe(true);
    expect(isExcludedEmail('INFO@Example.com')).toBe(true);
  });

  it('excludes anything that is not a routable address', () => {
    expect(isExcludedEmail('no-at-sign')).toBe(true);
    expect(isExcludedEmail('@nolocalpart.com')).toBe(true);
    expect(isExcludedEmail('nodomain@')).toBe(true);
    expect(isExcludedEmail('')).toBe(true);
  });

  it('uses the last @ so a quoted local part cannot smuggle a domain in', () => {
    expect(isExcludedEmail('user@notjunk@dralias.com')).toBe(true);
  });
});

describe('domainOf', () => {
  it('returns the lowercased domain part', () => {
    expect(domainOf('  Ada@Example.COM ')).toBe('example.com');
  });

  it('returns empty for an unroutable address', () => {
    expect(domainOf('no-at-sign')).toBe('');
    expect(domainOf('@leading.com')).toBe('');
    expect(domainOf('trailing@')).toBe('');
  });
});

describe('isConsumerEmail', () => {
  it('flags mainstream consumer mailboxes', () => {
    expect(isConsumerEmail('ada@gmail.com')).toBe(true);
    expect(isConsumerEmail('ada@YAHOO.co.uk')).toBe(true);
    expect(isConsumerEmail('ada@qq.com')).toBe(true);
  });

  it('flags privacy relays that read as custom domains', () => {
    expect(isConsumerEmail('ada@duck.com')).toBe(true);
    expect(isConsumerEmail('ada@pm.me')).toBe(true);
    expect(isConsumerEmail('ada@simplelogin.io')).toBe(true);
  });

  it('treats subdomains of a consumer domain as consumer', () => {
    expect(isConsumerEmail('ada@mail.duck.com')).toBe(true);
  });

  it('does not flag a domain that merely ends with the same letters', () => {
    expect(isConsumerEmail('ada@notgmail.com')).toBe(false);
  });

  it('flags an unroutable address', () => {
    expect(isConsumerEmail('nonsense')).toBe(true);
  });

  it('leaves real company domains alone', () => {
    expect(isConsumerEmail('ada@stripe.com')).toBe(false);
  });

  describe('brand families', () => {
    // Every one of these reached the live feed on 2026-09-14 because the
    // exact-match list did not enumerate them.
    it.each([
      'yahoo.de',
      'yahoo.com.br',
      'yahoo.co.jp',
      'outlook.de',
      'hotmail.de',
      'live.de',
      'bk.ru',
      'list.ru',
      'inbox.ru',
      'tuta.io',
      'tutamail.com',
      'tutanota.com',
      'disroot.org',
      'gmx.at',
    ])('flags %s as a consumer country variant', (domain) => {
      expect(isConsumerEmail(`ada@${domain}`)).toBe(true);
    });

    it('does not mistake a corporate mail subdomain for the mail.com family', () => {
      // `mail.acme.com`: second label is a brand, not a 2-3 letter TLD.
      expect(isConsumerEmail('ada@mail.acme.com')).toBe(false);
    });

    it('catches a consumer brand behind a subdomain', () => {
      expect(isConsumerEmail('ada@mail.yahoo.de')).toBe(true);
      expect(isConsumerEmail('ada@imap.gmx.net')).toBe(true);
    });

    it('keeps companies whose name is also a consumer mail brand', () => {
      // Consumer on their mail TLD, corporate everywhere else.
      expect(isConsumerEmail('ada@comcast.net')).toBe(true);
      expect(isConsumerEmail('ada@comcast.com')).toBe(false);
      expect(isConsumerEmail('ada@orange.fr')).toBe(true);
      expect(isConsumerEmail('ada@orange.com')).toBe(false);
      expect(isConsumerEmail('ada@web.de')).toBe(true);
      expect(isConsumerEmail('ada@web.com')).toBe(false);
      expect(isConsumerEmail('ada@free.fr')).toBe(true);
      expect(isConsumerEmail('ada@free.com')).toBe(false);
    });

    it('still catches the mail.com family through the exact list', () => {
      expect(isConsumerEmail('ada@mail.com')).toBe(true);
      expect(isConsumerEmail('ada@engineer.com')).toBe(true);
      expect(isConsumerEmail('ada@bk.ru')).toBe(true);
    });

    it('does not flag a company whose name merely starts with a brand word', () => {
      expect(isConsumerEmail('ada@livestorm.co')).toBe(false);
      expect(isConsumerEmail('ada@freshmail.io')).toBe(false);
      expect(isConsumerEmail('ada@webflow.com')).toBe(false);
    });
  });

  describe('relays and disposables', () => {
    it.each([
      'privaterelay.appleid.com',
      'passinbox.com',
      'passmail.net',
      'mozmail.com',
      'sharklasers.com',
      'yopmail.com',
      'harakirimail.com',
      'agentmail.to',
    ])('flags %s', (domain) => {
      expect(isConsumerEmail(`ada@${domain}`)).toBe(true);
    });
  });

  describe('universities', () => {
    it.each([
      'berkeley.edu',
      'csu.fullerton.edu',
      'iit.du.ac.bd',
      'diu.edu.bd',
      'alfalah.ac.id',
      'blps.tyc.edu.tw',
      'pace.edu.in',
      'campus.technion.ac.il',
    ])('flags %s as academic', (domain) => {
      expect(isConsumerEmail(`ada@${domain}`)).toBe(true);
    });

    it('does not flag a company that happens to contain "edu"', () => {
      expect(isConsumerEmail('ada@educative.io')).toBe(false);
      expect(isConsumerEmail('ada@procedure.com')).toBe(false);
    });

    it('only treats a two-letter country code as academic', () => {
      // `edu` / `ac` followed by a generic 3-letter TLD is a company, not a
      // university. Two letters is a country code by definition, so `.ac.uk`
      // and `.edu.bd` stay academic.
      expect(isConsumerEmail('ada@company.edu.com')).toBe(false);
      expect(isConsumerEmail('ada@startup.ac.dev')).toBe(false);
      expect(isConsumerEmail('ada@startup.ac.app')).toBe(false);
    });
  });
});

describe('isCorporateSignupEmail', () => {
  it('admits a company address', () => {
    expect(isCorporateSignupEmail('ada@stripe.com')).toBe(true);
  });

  it('rejects consumer mail', () => {
    expect(isCorporateSignupEmail('ada@gmail.com')).toBe(false);
  });

  it('rejects addresses the shared exclusion list already covers', () => {
    expect(isCorporateSignupEmail('support@stripe.com')).toBe(false);
    expect(isCorporateSignupEmail('ada@manifest.build')).toBe(false);
    expect(isCorporateSignupEmail('ada@atomicmail.io')).toBe(false);
  });
});

describe('isSignupCluster', () => {
  const at = (iso: string, has_traffic = false) => ({ signed_up_at: iso, has_traffic });

  it('flags three trafficless signups inside a month', () => {
    expect(
      isSignupCluster([
        at('2026-03-01T00:00:00.000Z'),
        at('2026-03-10T00:00:00.000Z'),
        at('2026-03-18T00:00:00.000Z'),
      ]),
    ).toBe(true);
  });

  it('spares a domain below the signup threshold', () => {
    expect(isSignupCluster([at('2026-03-01T00:00:00.000Z'), at('2026-03-02T00:00:00.000Z')])).toBe(
      false,
    );
  });

  it('spares a domain where anyone ever sent a request', () => {
    expect(
      isSignupCluster([
        at('2026-03-01T00:00:00.000Z'),
        at('2026-03-10T00:00:00.000Z'),
        at('2026-03-18T00:00:00.000Z', true),
      ]),
    ).toBe(false);
  });

  it('spares a team that trickled in over more than a month', () => {
    expect(
      isSignupCluster([
        at('2026-01-01T00:00:00.000Z'),
        at('2026-03-10T00:00:00.000Z'),
        at('2026-06-18T00:00:00.000Z'),
      ]),
    ).toBe(false);
  });

  it('judges the span regardless of row order', () => {
    expect(
      isSignupCluster([
        at('2026-06-18T00:00:00.000Z'),
        at('2026-01-01T00:00:00.000Z'),
        at('2026-03-10T00:00:00.000Z'),
      ]),
    ).toBe(false);
  });
});

describe('isMachineGeneratedDomain', () => {
  it('flags a domain where every local part is letters then digits', () => {
    // aratrin.com and lidugw.com on the first live dry run.
    expect(isMachineGeneratedDomain(['vatiy14692', 'xiyese3594'])).toBe(true);
    expect(isMachineGeneratedDomain(['lidosej357', 'safoh51835'])).toBe(true);
    expect(isMachineGeneratedDomain(['gimade8897', 'taribe8832', 'wipejet728'])).toBe(true);
  });

  it('never judges a single address', () => {
    expect(isMachineGeneratedDomain(['john1985'])).toBe(false);
  });

  it('spares a domain where anyone has a human-looking address', () => {
    expect(isMachineGeneratedDomain(['john1985', 'ada.lovelace'])).toBe(false);
    expect(isMachineGeneratedDomain(['vatiy14692', 'grace'])).toBe(false);
  });

  it('does not match shapes outside the generator pattern', () => {
    expect(isMachineGeneratedDomain(['ab12', 'cd34'])).toBe(false); // too short
    expect(isMachineGeneratedDomain(['a.b1234', 'c-d5678'])).toBe(false); // punctuation
    expect(isMachineGeneratedDomain(['1234abcd', '5678efgh'])).toBe(false); // digits first
  });
});
