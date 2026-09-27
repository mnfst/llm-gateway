import { Transform } from 'class-transformer';
import { IsEmail, IsIn, MaxLength, ValidateIf } from 'class-validator';

/** Claim origins this route may record; `website` belongs to Peacock's own form. */
export const PIVOT_CLAIM_SOURCES = ['cloud', 'self-hosted'] as const;
export type PivotClaimSource = (typeof PIVOT_CLAIM_SOURCES)[number];

/** Fallback when a claim carries no source and no same-origin signal. */
export const DEFAULT_PIVOT_CLAIM_SOURCE: PivotClaimSource = 'self-hosted';

/** Body of the public pivot waiting-list claim. */
export class PivotClaimDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Where the claim was made; absent defaults to self-hosted. Explicit
   * null is rejected: only omission earns the default. */
  @ValidateIf((claim) => claim.source !== undefined)
  @IsIn([...PIVOT_CLAIM_SOURCES])
  source?: PivotClaimSource;
}
