/** Shapes returned by the internal CRM metrics feed. */

/** One Manifest user whose failing requests Autofix repaired. */
export interface CrmHealedUser {
  /** Lowercased primary address. The CRM dedupes people on this. */
  email: string;
  /** Display name from the auth record, or null when never set. */
  name: string | null;
  /** Heals inside the requested window — the number worth quoting to them. */
  healed_recent: number;
  /** Heals since Autofix shipped, across every tenant this user owns. */
  healed_all: number;
  first_heal_at: string;
  last_heal_at: string;
}

/** One pivot waiting-list claim: the conversion signal for the campaign. */
export interface CrmWaitlistClaim {
  email: string;
  source: string;
  claimed_at: string;
}

/** Raw cohort row, one per (user, tenant) pair, before merging. */
export interface CohortRow {
  email: string;
  user_name: string | null;
  tenant_id: string;
  healed_recent: string | number;
  healed_all: string | number;
  first_heal_at: Date | string;
  last_heal_at: Date | string;
}

/**
 * One corporate signup: a verified user on an organisation domain.
 *
 * Never someone on the pivot waiting list: those people are worked by hand
 * and must not also receive the templated signup email.
 *
 * Deliberately thinner than `CrmHealedUser`. Per-tenant request aggregates
 * (error counts, 30-day volume) cost a heap fetch per row and took 22s across
 * this cohort in production; a single index probe for the latest request is
 * 93ms and answers the only question the copy branches on — has this person
 * ever actually used the gateway.
 */
export interface CrmCorporateSignup {
  /** Lowercased primary address. The CRM dedupes people on this. */
  email: string;
  /** Display name from the auth record, or null when never set. */
  name: string | null;
  /** Lowercased domain part, so the CRM can group people onto a company. */
  domain: string;
  signed_up_at: string;
  /** Null when this tenant has never sent a request. */
  last_request_at: string | null;
  /** `last_request_at !== null`, precomputed so template branching is trivial. */
  has_traffic: boolean;
  /** Verified signups sharing this domain — the "team behind it" signal. */
  domain_signups: number;
}

/** Raw signup row, one per (user, tenant) pair, before filtering. */
export interface SignupRow {
  email: string;
  user_name: string | null;
  signed_up_at: Date | string;
  last_request_at: Date | string | null;
}
