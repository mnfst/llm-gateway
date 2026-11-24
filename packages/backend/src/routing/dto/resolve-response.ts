import { ScoringReason } from '../../scoring';
import type {
  ModelRoute,
  ResponseMode,
  OutputModality,
  SpecificityCategory,
  TierSlot,
} from 'manifest-shared';

export type { AuthType } from 'manifest-shared';

export interface ResolveResponse {
  tier: TierSlot;
  confidence: number;
  score: number;
  reason: ScoringReason;
  /**
   * Resolved routing identity. Null when no model could be picked (no
   * provider connected, override invalidated, etc.). Replaces the legacy
   * flat `model` / `provider` / `auth_type` fields removed in this release;
   * read `route.model`, `route.provider`, `route.authType` instead.
   */
  route: ModelRoute | null;
  /**
   * Ordered fallback routes for the resolved tier. Null when none configured.
   * Replaces the legacy `fallback_models: string[]` field.
   */
  fallback_routes: ModelRoute[] | null;
  /** Effective output modality configured on the resolved routing chain. */
  output_modality?: OutputModality;
  /** Effective transport policy configured on the resolved routing chain. */
  response_mode?: ResponseMode;
  specificity_category?: SpecificityCategory;
  header_tier_id?: string;
  header_tier_name?: string;
  header_tier_color?: string;
  /**
   * Model named by a pinned routing override that could not be resolved even
   * though its provider connection exists. The proxy turns this into M302
   * ("model not available") instead of M101 ("no model to route to").
   */
  override_model_unavailable?: string;
}
