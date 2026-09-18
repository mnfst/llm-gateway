import type { SpecificityCategory } from 'manifest-shared';

/**
 * Per-keyword weights used by specificity detection. Keywords not in this map
 * default to 1.0. Strong anchor phrases (`navigate to`, `scrape`) weigh more
 * than weak generics (`website`) so that a single strong phrase can activate
 * a category but a single generic cannot.
 *
 * Tune these when discussion #1613-style misrouting re-appears on new vocab.
 */
export const KEYWORD_WEIGHTS: Record<string, number> = {
  // web_browsing — unambiguous anchors
  'navigate to': 4,
  'browse to': 4,
  scrape: 4,
  crawl: 4,
  'open url': 4,
  'fetch url': 4,
  'fetch the url': 4,
  'take a screenshot': 4,
  'web search': 4,
  'bookmark this': 4,
  'fill out the form': 4,

  // web_browsing — strong browse verbs
  browse: 3,
  visit: 3,
  navigate: 3,
  'go to': 3,
  'open this': 3,
  'search for': 3,
  'search on': 3,
  'fill out': 3,
  'look up': 3,
  'scroll to': 3,
  'scroll down': 3,
  'scroll up': 3,

  // web_browsing — strong qualified context phrases (only appear on browse
  // prompts — realistic coding prompts use "the site/page/url" not "this")
  'this website': 3,
  'this webpage': 3,
  'this site': 3,
  'this url': 3,
  'on this page': 3,
  'on this site': 3,
  'on this website': 3,
  'from this page': 3,

  // web_browsing — medium context phrases
  'this page': 3,
  'this domain': 2,
  'open the url': 2,
  'click the': 2,
  'click on': 2,
  'click on the': 2,
  'screenshot of': 2,
  webpage: 2,

  // web_browsing — weaker nouns (need another signal to cross threshold)
  website: 1.5,
  'web page': 1.5,

  // private_docs — distinctive anchors that must dominate over generic verbs
  // like "analyze" (which fires data_analysis) or "coding" (which fires coding).
  // Without these boosts, a prompt like "analyze the patient's medical record"
  // would be misrouted to data_analysis because "analyze" matches there too.
  // A single weight-3 private_docs match (threshold 1.0) clears activation
  // and outscores a weight-1 data_analysis keyword.
  hipaa: 3,
  'hipaa-compliant': 3,
  gdpr: 3,
  'gdpr-compliant': 3,
  ccpa: 3,
  pdpa: 3,
  sox: 0.5, // sub-threshold: SoX audio library collision
  'sarbanes-oxley': 3,
  'personal data': 3,
  'sensitive data': 3,
  'personal information': 3,
  'protected health information': 3,
  phi: 0.5, // sub-threshold: math.phi / phi-coefficient collision
  pii: 3, // kept strong: unambiguous PII acronym
  confidential: 0.5, // sub-threshold: "this document is confidential" is too common
  'privileged communication': 3,
  'attorney-client privilege': 3,
  'work product privilege': 3,
  'attorney work product': 3,
  'medical record': 3,
  'medical records': 3,
  'patient record': 3,
  'patient information': 3,
  'patient file': 3,
  'patient data': 3,
  'patient medical records': 3,
  'patient medical history': 3,
  'clinical note': 3,
  'clinical record': 3,
  prescription: 0.5, // sub-threshold: react "prescription pattern" collision
  diagnosis: 0.5, // sub-threshold: icd-mapping coding prompt collision
  'treatment plan': 3,
  'health record': 3,
  'health records': 3,
  'healthcare data': 3,
  'health data': 3,
  'medical history': 3,
  'medical document': 3,
  'medical file': 3,
  'medical files': 3,
  'healthcare document': 3,
  'health document': 3,
  'health files': 3,
  nda: 0.5, // sub-threshold: "network dynamic affinity" collision
  'non-disclosure agreement': 3,
  'confidentiality agreement': 3,
  'confidential agreement': 3,
  'master service agreement': 3,
  msa: 0.5, // sub-threshold: biopython multiple-sequence-alignment collision
  'service agreement': 3,
  'client agreement': 3,
  'employment agreement': 3,
  'settlement agreement': 3,
  'legal brief': 3,
  'brief filed': 3,
  'motion to dismiss': 3,
  'discovery document': 3,
  'discovery document set': 3,
  'discovery documents': 3,
  'deposition transcript': 3,
  'witness statement': 3,
  testimony: 0.5, // sub-threshold: mock-object "witness testimony" collision
  'insurance claim': 3,
  'claims processing': 3,
  'medical claim': 3,
  'benefits claim': 3,
  'financial statement': 3,
  'financial statements': 3,
  'audit trail': 3,
  'audit log': 3,
  'tax return': 3,
  'tax document': 3,
  'pay stub': 3,
  'paycheck stub': 3,
  'payroll record': 3,
  'payroll records': 3,
  'payroll data': 3,
  'payroll document': 3,
  'w2 form': 3,
  'w-2 form': 3,
  'my w-2': 3,
  'my w2': 3,
  'w-2 withholding': 3,
  'w2 withholding': 3,
  '1099 form': 3,
  '1099 income': 3,
  '1099 statement': 3,
  'my 1099': 3,
  '1099 withholding': 3,
  '1099 tax': 3,
  'my bank statement': 3,
  'brokerage statement': 3,
  'investment statement': 3,
  'mortgage statement': 3,
  'tax statement': 3,
  'background check': 3,
  'security clearance': 3,
  'performance review': 3,
  'disciplinary action': 3,
  'termination letter': 3,
  'nda signed': 3,
  'compliance document': 3,
  'regulatory document': 3,
  'regulatory filing': 3,
  'regulatory report': 3,
  'soc 2': 3,
  'soc 1': 3,
  'soc 3': 3,
  soc2: 0.5, // sub-threshold: react "soc2 badge" / component-name collision
  'legal document': 3,
  'financial document': 3,
  'hr document': 3,
  'hr record': 3,
  'employee record': 3,
  'employee file': 3,
  'customer record': 3,
  'client file': 3,
  'confidential file': 3,
  'privileged file': 3,
  'sensitive file': 3,
  'regulated file': 3,

  // ── Financial / retirement account documents ──
  'my 401k': 3,
  '401k statement': 3,
  '401 k statement': 3,
  '401(k) statement': 3,
  'my ira': 3,
  'ira statement': 3,
  'roth ira statement': 3,
  'traditional ira statement': 3,
  'my roth ira': 3,
  'my hsa': 3,
  'hsa statement': 3,
  'hsa account': 3,
  'my fsa': 3,
  'fsa statement': 3,
  'fsa account': 3,
  '529 plan statement': 3,
  '529 statement': 3,
  '529 savings statement': 3,
  'my 529': 3,
  '529 contribution': 3,
  'brokerage account statement': 3,
  'investment account statement': 3,
  'retirement account statement': 3,
  'pension statement': 3,
  'pension plan document': 3,

  // ── Additional document-context phrases ──
  'my tax return': 3,
  'file my taxes': 3,
  'irs document': 3,
  'irs notice': 3,
  'irs letter': 3,
  'credit score report': 3,
  'credit report': 3,

  // ── Document actions ──
  'summarize this document': 3,
  'summarize the document': 3,
  'review this document': 3,
  'review the document': 3,
  'read this document': 3,
  'read the document': 3,
  'analyze this document': 3,
  'analyze the document': 3,
  'parse this document': 3,
  'extract from this document': 3,
  'redact this document': 3,
  'redact the document': 3,
  'anonymize this document': 3,
  'de-identify this document': 3,
  'deidentify this document': 3,
  'review this confidential': 3,
  'read this confidential': 3,
  'read this privileged': 3,
  'summarize this confidential': 3,
  'summarize this privileged': 3,
  'process this document securely': 3,
  'keep this confidential': 3,
  'handle this securely': 3,
  'process with encryption': 3,
  'confidential compute': 3,
  'confidential processing': 3,

  // ── Conversation framing ──
  'private document conversation': 3,
  'private doc conversation': 3,
  'sensitive document conversation': 3,
  'confidential conversation': 3,
  'secure conversation': 3,
  'encrypted conversation': 3,
  'end-to-end encrypted': 3,
  'confidential computing': 3,
  privatemode: 3,
  'private mode': 3,
  'secure ai': 3,
  'encrypted ai': 3,
  'verifiable compute': 3,
  'remote attestation': 3,
  'confidential vm': 3,
  'confidential container': 3,

  // ── Regulated industry document contexts ──
  'client data': 1,
  'customer data': 1,
  'protected data': 1,
  'regulated data': 1,
};

/**
 * Minimum weighted score required to activate each category.
 *
 * web_browsing is intentionally high (matches the strong-anchor weight of 3):
 * a single generic match like `website` (1.5) or `click the` (2) must combine
 * with additional signal before it flips routing. Other categories stay at 1.0
 * so prior positive-detection coverage (80%+ on 100 prompts per category)
 * remains intact — they never had the false-positive blast radius that
 * web_browsing did. The `coding` false positive in #1767 was fixed at the
 * signal source (trimming generic tool names, requiring a substantive code
 * fence body, peeling agent metadata envelopes) rather than by raising this
 * threshold — which would have hurt detection accuracy on real coding
 * prompts that only carry a single technical keyword.
 */
export const ACTIVATION_THRESHOLDS: Record<SpecificityCategory, number> = {
  coding: 1.0,
  web_browsing: 3.0,
  data_analysis: 1.0,
  image_generation: 1.0,
  video_generation: 1.0,
  social_media: 1.0,
  email_management: 1.0,
  calendar_management: 1.0,
  trading: 1.0,
  private_docs: 1.0,
};

/** Weight a single keyword match. Unknown keywords fall back to 1.0. */
export function weightFor(keyword: string): number {
  return KEYWORD_WEIGHTS[keyword] ?? 1;
}
