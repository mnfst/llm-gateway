// Single source of truth for the TypeORM entity and migration registries.
// Both the app DataSource (database.module) and the migration CLI/pre-deploy
// runner (datasource.ts -> migrate.ts) import these, so boot and deploy apply
// the exact same migration set. Using an explicit array (not a dist glob) keeps
// stale compiled .js from deleted migrations out of the run (deleteOutDir is off).
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';
import { ApiKey } from '../entities/api-key.entity';
import { Tenant } from '../entities/tenant.entity';
import { Agent } from '../entities/agent.entity';
import { AgentApiKey } from '../entities/agent-api-key.entity';
import { NotificationRule } from '../entities/notification-rule.entity';
import { NotificationLog } from '../entities/notification-log.entity';
import { EmailProviderConfig } from '../entities/email-provider-config.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';
import { HeaderTier } from '../entities/header-tier.entity';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { BackfillState } from '../entities/backfill-state.entity';
import { AgentModelParams } from '../entities/agent-model-params.entity';
import { PlaygroundRun } from '../entities/playground-run.entity';
import { PlaygroundColumn } from '../entities/playground-column.entity';
import { ReasoningContentCacheEntry } from '../entities/reasoning-content-cache-entry.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { PublicErrorPage } from '../entities/public-error-page.entity';
import { WaitlistClaim } from '../entities/waitlist-claim.entity';
import { TenantRequestUsage } from '../entities/tenant-request-usage.entity';
import { CliAuthCode } from '../entities/cli-auth-code.entity';
import { AgentUsageDaily } from '../entities/agent-usage-daily.entity';
import { RenameWaitlistClaimsTable1800000000000 } from './migrations/1800000000000-RenameWaitlistClaimsTable';
import { ReclassifyPlanRequestLimitMessages1800100000000 } from './migrations/1800100000000-ReclassifyPlanRequestLimitMessages';
import { AddMessageErrorCode1800200000000 } from './migrations/1800200000000-AddMessageErrorCode';
import { DropUnusedAgentMessageIndexes1800300000000 } from './migrations/1800300000000-DropUnusedAgentMessageIndexes';
import { ExtendDashboardCoveringIndex1801200000000 } from './migrations/1801200000000-ExtendDashboardCoveringIndex';

import { AddTenantRequestUsage1801300000000 } from './migrations/1801300000000-AddTenantRequestUsage';
import { AddRequestRecordings1801300000000 } from './migrations/1801300000000-AddRequestRecordings';
import { MoveRecordingsToProviderAttempts1801400000000 } from './migrations/1801400000000-MoveRecordingsToProviderAttempts';
import { EnableRecordingForNewAgents1801500000000 } from './migrations/1801500000000-EnableRecordingForNewAgents';
import { DropLegacyAutofixRolloutColumns1801600000000 } from './migrations/1801600000000-DropLegacyAutofixRolloutColumns';
import { AddApiKeyExpiresAt1801700000000 } from './migrations/1801700000000-AddApiKeyExpiresAt';
import { CreateCliAuthCodes1801710000000 } from './migrations/1801710000000-CreateCliAuthCodes';
import { AddRequestApiMode1801720000000 } from './migrations/1801720000000-AddRequestApiMode';
import { AddCliAuthCodeChallenge1801730000000 } from './migrations/1801730000000-AddCliAuthCodeChallenge';
import { AddApiKeyAbsoluteExpiresAt1801740000000 } from './migrations/1801740000000-AddApiKeyAbsoluteExpiresAt';
import { AddAutofixConsentToInstallMetadata1801900000000 } from './migrations/1801900000000-AddAutofixConsentToInstallMetadata';
import { SlimTenantAgentModelIndex1802000000000 } from './migrations/1802000000000-SlimTenantAgentModelIndex';
import { AddCustomProviderAlias1802100000000 } from './migrations/1802100000000-AddCustomProviderAlias';
import { AddRequestsAutofixHealedIndex1802200000000 } from './migrations/1802200000000-AddRequestsAutofixHealedIndex';
import { TuneFactTableAutovacuum1802400000000 } from './migrations/1802400000000-TuneFactTableAutovacuum';
import { AddAgentMessagesUnlinkedIndex1802500000000 } from './migrations/1802500000000-AddAgentMessagesUnlinkedIndex';
import { AddAgentMessagesRecordingIndex1802600000000 } from './migrations/1802600000000-AddAgentMessagesRecordingIndex';
import { AddAgentMessagesAutofixAttemptIndex1802700000000 } from './migrations/1802700000000-AddAgentMessagesAutofixAttemptIndex';
import { AddAgentUsageDaily1802800000000 } from './migrations/1802800000000-AddAgentUsageDaily';
import { AddAgentMessagesDirectUsageIndex1802900000000 } from './migrations/1802900000000-AddAgentMessagesDirectUsageIndex';
import { CoverRequestsLogFilters1803000000000 } from './migrations/1803000000000-CoverRequestsLogFilters';
import { CoverHarnessRequestsIndex1803100000000 } from './migrations/1803100000000-CoverHarnessRequestsIndex';
import { InitialSchema1771464895790 } from './migrations/1771464895790-InitialSchema';
import { HashApiKeys1771500000000 } from './migrations/1771500000000-HashApiKeys';
import { ModelPricingImprovements1771600000000 } from './migrations/1771600000000-ModelPricingImprovements';
import { EmailProviderConfigs1771700000000 } from './migrations/1771700000000-EmailProviderConfigs';
import { AddNotificationEmailAndOptionalDomain1771800000000 } from './migrations/1771800000000-AddNotificationEmailAndOptionalDomain';
import { AddModelCapabilities1771600000000 } from './migrations/1771600000000-AddModelCapabilities';
import { AddRoutingTables1771700000000 } from './migrations/1771700000000-AddRoutingTables';
import { AddQualityScore1771800000000 } from './migrations/1771800000000-AddQualityScore';
import { SeedQualityScores1771800100000 } from './migrations/1771800100000-SeedQualityScores';
import { EncryptApiKeys1771900000000 } from './migrations/1771900000000-EncryptApiKeys';
import { MakeApiKeyNullable1772000000000 } from './migrations/1772000000000-MakeApiKeyNullable';
import { AddRoutingTier1772100000000 } from './migrations/1772100000000-AddRoutingTier';
import { AddLimitAction1772200000000 } from './migrations/1772200000000-AddLimitAction';
import { AddRoutingReason1772300000000 } from './migrations/1772300000000-AddRoutingReason';
import { AddAgentDisplayName1772400000000 } from './migrations/1772400000000-AddAgentDisplayName';
import { PerAgentRouting1772500000000 } from './migrations/1772500000000-PerAgentRouting';
import { AddCustomProviders1772668898071 } from './migrations/1772668898071-AddCustomProviders';
import { NullablePricing1772682112419 } from './migrations/1772682112419-NullablePricing';
import { AddPerformanceIndexes1772843035514 } from './migrations/1772843035514-AddPerformanceIndexes';
import { AddProviderAuthType1772900000000 } from './migrations/1772900000000-AddProviderAuthType';
import { AddDashboardIndexes1772905146384 } from './migrations/1772905146384-AddDashboardIndexes';
import { AddFallbacks1772905260464 } from './migrations/1772905260464-AddFallbacks';
import { AddModelDisplayName1772920000000 } from './migrations/1772920000000-AddModelDisplayName';
import { DropRedundantIndexes1772940000000 } from './migrations/1772940000000-DropRedundantIndexes';
import { BackfillTenantId1772948502780 } from './migrations/1772948502780-BackfillTenantId';
import { DropUnusedIndexes1772960000000 } from './migrations/1772960000000-DropUnusedIndexes';
import { PurgeNonCuratedModels1772960000000 } from './migrations/1772960000000-PurgeNonCuratedModels';
import { ExpandProviderUniqueKey1773000000000 } from './migrations/1773000000000-ExpandProviderUniqueKey';
import { AddOverrideAuthType1773100000000 } from './migrations/1773100000000-AddOverrideAuthType';
import { AddMessageAuthType1773200000000 } from './migrations/1773200000000-AddMessageAuthType';
import { AddModelsAgentIndex1773202787708 } from './migrations/1773202787708-AddModelsAgentIndex';
import { AddEmailProviderKeyPrefix1773300000000 } from './migrations/1773300000000-AddEmailProviderKeyPrefix';
import { AddProviderModelCache1773400000000 } from './migrations/1773400000000-AddProviderModelCache';
import { DropModelPricingTables1773500000000 } from './migrations/1773500000000-DropModelPricingTables';
import { AddOverrideProvider1773600000000 } from './migrations/1773600000000-AddOverrideProvider';
import { AddProviderRegion1773650000000 } from './migrations/1773650000000-AddProviderRegion';
import { DropSecurityEventTable1773700000000 } from './migrations/1773700000000-DropSecurityEventTable';
import { FixNegativeCosts1773800000000 } from './migrations/1773800000000-FixNegativeCosts';
import { AddKeyPrefixIndex1773900000000 } from './migrations/1773900000000-AddKeyPrefixIndex';
import { WidenKeyHashColumn1774000000000 } from './migrations/1774000000000-WidenKeyHashColumn';
import { WidenApiKeyColumn1774896789000 } from './migrations/1774896789000-WidenApiKeyColumn';
import { AddErrorHttpStatus1775000000000 } from './migrations/1775000000000-AddErrorHttpStatus';
import { AddAgentType1775100000000 } from './migrations/1775100000000-AddAgentType';
import { AddSpecificityAssignments1775200000000 } from './migrations/1775200000000-AddSpecificityAssignments';
import { AddSpecificityCategory1775300000000 } from './migrations/1775300000000-AddSpecificityCategory';
import { AddCallerAttribution1775400000000 } from './migrations/1775400000000-AddCallerAttribution';
import { AddMessageProvider1775500000000 } from './migrations/1775500000000-AddMessageProvider';
import { AddMessageFeedback1775600000000 } from './migrations/1775600000000-AddMessageFeedback';
import { AddInstallMetadata1775700000000 } from './migrations/1775700000000-AddInstallMetadata';
import { CleanupOrphanedCustomProviderRefs1776679833383 } from './migrations/1776679833383-CleanupOrphanedCustomProviderRefs';
import { AddMessageRequestHeaders1776700000000 } from './migrations/1776700000000-AddMessageRequestHeaders';
import { AddHeaderTiers1776710000000 } from './migrations/1776710000000-AddHeaderTiers';
import { AddSpecificityMiscategorized1777000000000 } from './migrations/1777000000000-AddSpecificityMiscategorized';
import { AddComplexityRoutingFlag1777100000000 } from './migrations/1777100000000-AddComplexityRoutingFlag';
import { AddHeaderTierEnabled1777100000000 } from './migrations/1777100000000-AddHeaderTierEnabled';
import { AddCustomProviderApiKind1777200000000 } from './migrations/1777200000000-AddCustomProviderApiKind';
import { CanonicalizeTileProviderMessages1777200000000 } from './migrations/1777200000000-CanonicalizeTileProviderMessages';
import { BackfillLocalAuthType1777200000000 } from './migrations/1777200000000-BackfillLocalAuthType';
import { BackfillLocalCustomProviders1777300000000 } from './migrations/1777300000000-BackfillLocalCustomProviders';
import { DropComplexityRoutingFlag1780000000000 } from './migrations/1780000000000-DropComplexityRoutingFlag';
import { ReAddComplexityRoutingFlag1781000000000 } from './migrations/1781000000000-ReAddComplexityRoutingFlag';
import { RetuneSpecificityMiscategorizedIndex1782000000000 } from './migrations/1782000000000-RetuneSpecificityMiscategorizedIndex';
import { AddAgentSoftDelete1782200000000 } from './migrations/1782200000000-AddAgentSoftDelete';
import { AddModelRouteColumns1783000000000 } from './migrations/1783000000000-AddModelRouteColumns';
import { DropLegacyRoutingColumns1784000000000 } from './migrations/1784000000000-DropLegacyRoutingColumns';
import { AddParamDefaultsColumns1785000000000 } from './migrations/1785000000000-AddParamDefaultsColumns';
import { AddProviderKeyLabelAndPriority1785000000000 } from './migrations/1785000000000-AddProviderKeyLabelAndPriority';
import { AddProviderKeyLabelToAgentMessages1785100000000 } from './migrations/1785100000000-AddProviderKeyLabelToAgentMessages';
import { AddRequestParamsColumn1786000000000 } from './migrations/1786000000000-AddRequestParamsColumn';
import { AddAgentRecordMessages1786100000000 } from './migrations/1786100000000-AddAgentRecordMessages';
import { AddMessageRecordings1786200000000 } from './migrations/1786200000000-AddMessageRecordings';
import { DefaultRecordMessagesTrue1786300000000 } from './migrations/1786300000000-DefaultRecordMessagesTrue';
import { AddAgentModelParams1787000000000 } from './migrations/1787000000000-AddAgentModelParams';
import { AddBenchmarkHistory1788000000000 } from './migrations/1788000000000-AddBenchmarkHistory';
import { RenameBenchmarkToPlayground1789000000000 } from './migrations/1789000000000-RenameBenchmarkToPlayground';
import { AddOAuthPendingFlows1789100000000 } from './migrations/1789100000000-AddOAuthPendingFlows';
import { ScopeAgentModelParams1789200000000 } from './migrations/1789200000000-ScopeAgentModelParams';
import { EnableRecordMessagesForAll1789300000000 } from './migrations/1789300000000-EnableRecordMessagesForAll';
import { AddRoutingOutputControls1789300000000 } from './migrations/1789300000000-AddRoutingOutputControls';
import { AddAgentApiKeyPrefixActiveIndex1790000000000 } from './migrations/1790000000000-AddAgentApiKeyPrefixActiveIndex';
import { AddReasoningContentCache1790100000000 } from './migrations/1790100000000-AddReasoningContentCache';
import { AddDedupCompositeIndex1790200000000 } from './migrations/1790200000000-AddDedupCompositeIndex';
import { AddErrorsPartialIndex1790300000000 } from './migrations/1790300000000-AddErrorsPartialIndex';
import { DropRedundantAgentApiKeyPrefixIndex1790400000000 } from './migrations/1790400000000-DropRedundantAgentApiKeyPrefixIndex';
import { LiftProvidersToUserLevel1791000000000 } from './migrations/1791000000000-LiftProvidersToUserLevel';
import { LiftCustomProvidersToUserLevel1791200000000 } from './migrations/1791200000000-LiftCustomProvidersToUserLevel';
import { SeedPlaygroundAgents1791400000000 } from './migrations/1791400000000-SeedPlaygroundAgents';
import { DropProviderRateLimits1791600000000 } from './migrations/1791600000000-DropProviderRateLimits';
import { DropSavingsBaselineColumns1791700000000 } from './migrations/1791700000000-DropSavingsBaselineColumns';
import { RenameProviderAccessToEnabledProviders1791800000000 } from './migrations/1791800000000-RenameProviderAccessToEnabledProviders';
import { RenameIsSystemToIsPlayground1791900000000 } from './migrations/1791900000000-RenameIsSystemToIsPlayground';
import { AddUserProviderIdToAgentMessages1792000000000 } from './migrations/1792000000000-AddUserProviderIdToAgentMessages';
import { AddCustomProviderFkToUserProviders1792100000000 } from './migrations/1792100000000-AddCustomProviderFkToUserProviders';
import { TenantOwnerColumn1792400000000 } from './migrations/1792400000000-TenantOwnerColumn';
import { TenantProviders1792500000000 } from './migrations/1792500000000-TenantProviders';
import { TenantScopedConfigs1792600000000 } from './migrations/1792600000000-TenantScopedConfigs';
import { DropUserScopeFromRouting1792700000000 } from './migrations/1792700000000-DropUserScopeFromRouting';
import { AddBackfillStateTable1792800000000 } from './migrations/1792800000000-AddBackfillStateTable';
import { TuneAgentMessagesAutovacuum1792900000000 } from './migrations/1792900000000-TuneAgentMessagesAutovacuum';
import { AddTenantProviderValueIndex1793000000000 } from './migrations/1793000000000-AddTenantProviderValueIndex';
import { DropRedundantTenantAgentNameIndex1793100000000 } from './migrations/1793100000000-DropRedundantTenantAgentNameIndex';
import { AddDashboardCoveringIndex1793200000000 } from './migrations/1793200000000-AddDashboardCoveringIndex';
import { AddCrossTenantErrorTimestampIndex1795100000000 } from './migrations/1795100000000-AddCrossTenantErrorTimestampIndex';
import { RemoveMessageRecording1795000000000 } from './migrations/1795000000000-RemoveMessageRecording';
import { AddAutofixWaitlist1796000000000 } from './migrations/1796000000000-AddAutofixWaitlist';
import { AddPublicErrorPages1797000000000 } from './migrations/1797000000000-AddPublicErrorPages';
import { AddErrorClassification1798000000000 } from './migrations/1798000000000-AddErrorClassification';
import { AddTenantLimitOverrides1798100000000 } from './migrations/1798100000000-AddTenantLimitOverrides';
import { AddBillingEmailLogs1798200000000 } from './migrations/1798200000000-AddBillingEmailLogs';
import { AddBillingEmailPreferences1798300000000 } from './migrations/1798300000000-AddBillingEmailPreferences';
import { AddAutofixWaitlistSignups1799000000000 } from './migrations/1799000000000-AddAutofixWaitlistSignups';
import { AddAutofixAgentFlags1799000010000 } from './migrations/1799000010000-AddAutofixAgentFlags';
import { AddAutofixMessageFields1799000100000 } from './migrations/1799000100000-AddAutofixMessageFields';
import { AddAutofixPhoenixIds1799000200000 } from './migrations/1799000200000-AddAutofixPhoenixIds';
import { MakeAutofixEnabledNullable1799000300000 } from './migrations/1799000300000-MakeAutofixEnabledNullable';
import { AddAutofixAccessGrant1799000400000 } from './migrations/1799000400000-AddAutofixAccessGrant';
import { AddRequestsAndProviderAttempts1801000000000 } from './migrations/1801000000000-AddRequestsAndProviderAttempts';
import { AddProviderAttemptOrdering1801100000000 } from './migrations/1801100000000-AddProviderAttemptOrdering';

export const entities = [
  AgentMessage,
  ManifestRequest,
  ApiKey,
  Tenant,
  Agent,
  AgentApiKey,
  NotificationRule,
  NotificationLog,
  EmailProviderConfig,
  TenantProvider,
  TierAssignment,
  CustomProvider,
  SpecificityAssignment,
  HeaderTier,
  InstallMetadata,
  AgentModelParams,
  PlaygroundRun,
  PlaygroundColumn,
  ReasoningContentCacheEntry,
  AgentEnabledProvider,
  BackfillState,
  PublicErrorPage,
  WaitlistClaim,
  TenantRequestUsage,
  CliAuthCode,
  AgentUsageDaily,
];

export const migrations = [
  InitialSchema1771464895790,
  HashApiKeys1771500000000,
  ModelPricingImprovements1771600000000,
  EmailProviderConfigs1771700000000,
  AddNotificationEmailAndOptionalDomain1771800000000,
  AddModelCapabilities1771600000000,
  AddRoutingTables1771700000000,
  AddQualityScore1771800000000,
  SeedQualityScores1771800100000,
  EncryptApiKeys1771900000000,
  MakeApiKeyNullable1772000000000,
  AddRoutingTier1772100000000,
  AddLimitAction1772200000000,
  AddRoutingReason1772300000000,
  AddAgentDisplayName1772400000000,
  PerAgentRouting1772500000000,
  AddCustomProviders1772668898071,
  NullablePricing1772682112419,
  AddPerformanceIndexes1772843035514,
  AddProviderAuthType1772900000000,
  AddDashboardIndexes1772905146384,
  AddFallbacks1772905260464,
  AddModelDisplayName1772920000000,
  DropRedundantIndexes1772940000000,
  BackfillTenantId1772948502780,
  DropUnusedIndexes1772960000000,
  PurgeNonCuratedModels1772960000000,
  ExpandProviderUniqueKey1773000000000,
  AddOverrideAuthType1773100000000,
  AddMessageAuthType1773200000000,
  AddModelsAgentIndex1773202787708,
  AddEmailProviderKeyPrefix1773300000000,
  AddProviderModelCache1773400000000,
  DropModelPricingTables1773500000000,
  AddOverrideProvider1773600000000,
  AddProviderRegion1773650000000,
  DropSecurityEventTable1773700000000,
  FixNegativeCosts1773800000000,
  AddKeyPrefixIndex1773900000000,
  WidenKeyHashColumn1774000000000,
  WidenApiKeyColumn1774896789000,
  AddErrorHttpStatus1775000000000,
  AddAgentType1775100000000,
  AddSpecificityAssignments1775200000000,
  AddSpecificityCategory1775300000000,
  AddCallerAttribution1775400000000,
  AddMessageProvider1775500000000,
  AddMessageFeedback1775600000000,
  AddInstallMetadata1775700000000,
  CleanupOrphanedCustomProviderRefs1776679833383,
  AddMessageRequestHeaders1776700000000,
  AddHeaderTiers1776710000000,
  AddSpecificityMiscategorized1777000000000,
  AddComplexityRoutingFlag1777100000000,
  AddHeaderTierEnabled1777100000000,
  AddCustomProviderApiKind1777200000000,
  CanonicalizeTileProviderMessages1777200000000,
  BackfillLocalAuthType1777200000000,
  BackfillLocalCustomProviders1777300000000,
  DropComplexityRoutingFlag1780000000000,
  ReAddComplexityRoutingFlag1781000000000,
  RetuneSpecificityMiscategorizedIndex1782000000000,
  AddAgentSoftDelete1782200000000,
  AddModelRouteColumns1783000000000,
  DropLegacyRoutingColumns1784000000000,
  AddParamDefaultsColumns1785000000000,
  AddProviderKeyLabelAndPriority1785000000000,
  AddProviderKeyLabelToAgentMessages1785100000000,
  AddRequestParamsColumn1786000000000,
  AddAgentRecordMessages1786100000000,
  AddMessageRecordings1786200000000,
  DefaultRecordMessagesTrue1786300000000,
  AddAgentModelParams1787000000000,
  AddBenchmarkHistory1788000000000,
  RenameBenchmarkToPlayground1789000000000,
  AddOAuthPendingFlows1789100000000,
  ScopeAgentModelParams1789200000000,
  EnableRecordMessagesForAll1789300000000,
  AddRoutingOutputControls1789300000000,
  AddAgentApiKeyPrefixActiveIndex1790000000000,
  AddReasoningContentCache1790100000000,
  AddDedupCompositeIndex1790200000000,
  AddErrorsPartialIndex1790300000000,
  DropRedundantAgentApiKeyPrefixIndex1790400000000,
  LiftProvidersToUserLevel1791000000000,
  LiftCustomProvidersToUserLevel1791200000000,
  SeedPlaygroundAgents1791400000000,
  DropProviderRateLimits1791600000000,
  DropSavingsBaselineColumns1791700000000,
  RenameProviderAccessToEnabledProviders1791800000000,
  RenameIsSystemToIsPlayground1791900000000,
  AddUserProviderIdToAgentMessages1792000000000,
  AddCustomProviderFkToUserProviders1792100000000,
  TenantOwnerColumn1792400000000,
  TenantProviders1792500000000,
  TenantScopedConfigs1792600000000,
  DropUserScopeFromRouting1792700000000,
  AddBackfillStateTable1792800000000,
  TuneAgentMessagesAutovacuum1792900000000,
  AddTenantProviderValueIndex1793000000000,
  DropRedundantTenantAgentNameIndex1793100000000,
  AddDashboardCoveringIndex1793200000000,
  RemoveMessageRecording1795000000000,
  AddCrossTenantErrorTimestampIndex1795100000000,
  AddAutofixWaitlist1796000000000,
  AddPublicErrorPages1797000000000,
  AddErrorClassification1798000000000,
  AddTenantLimitOverrides1798100000000,
  AddBillingEmailLogs1798200000000,
  AddBillingEmailPreferences1798300000000,
  AddAutofixWaitlistSignups1799000000000,
  AddAutofixAgentFlags1799000010000,
  AddAutofixMessageFields1799000100000,
  AddAutofixPhoenixIds1799000200000,
  MakeAutofixEnabledNullable1799000300000,
  AddAutofixAccessGrant1799000400000,
  RenameWaitlistClaimsTable1800000000000,
  ReclassifyPlanRequestLimitMessages1800100000000,
  AddMessageErrorCode1800200000000,
  DropUnusedAgentMessageIndexes1800300000000,
  AddRequestsAndProviderAttempts1801000000000,
  AddProviderAttemptOrdering1801100000000,
  ExtendDashboardCoveringIndex1801200000000,

  AddTenantRequestUsage1801300000000,
  AddRequestRecordings1801300000000,
  MoveRecordingsToProviderAttempts1801400000000,
  EnableRecordingForNewAgents1801500000000,
  DropLegacyAutofixRolloutColumns1801600000000,
  AddApiKeyExpiresAt1801700000000,
  CreateCliAuthCodes1801710000000,
  AddRequestApiMode1801720000000,
  AddCliAuthCodeChallenge1801730000000,
  AddApiKeyAbsoluteExpiresAt1801740000000,
  AddAutofixConsentToInstallMetadata1801900000000,
  SlimTenantAgentModelIndex1802000000000,
  AddCustomProviderAlias1802100000000,
  AddRequestsAutofixHealedIndex1802200000000,
  TuneFactTableAutovacuum1802400000000,
  AddAgentMessagesUnlinkedIndex1802500000000,
  AddAgentMessagesRecordingIndex1802600000000,
  AddAgentMessagesAutofixAttemptIndex1802700000000,
  AddAgentUsageDaily1802800000000,
  AddAgentMessagesDirectUsageIndex1802900000000,
  CoverRequestsLogFilters1803000000000,
  CoverHarnessRequestsIndex1803100000000,
];
