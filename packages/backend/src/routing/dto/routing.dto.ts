import type { AuthType } from 'manifest-shared';
import {
  IsString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  Matches,
  MaxLength,
  ArrayMinSize,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import {
  AUTH_TYPES,
  MAX_FALLBACKS,
  RESPONSE_MODES,
  TIER_SLOTS,
  type ResponseMode,
} from 'manifest-shared';
import { PROVIDER_BY_ID_OR_ALIAS } from '../../common/constants/providers';

const KNOWN_PROVIDER_IDS: readonly string[] = Array.from(PROVIDER_BY_ID_OR_ALIAS.keys());

export const MAX_PROVIDER_KEY_LABEL_LENGTH = 50;

export class ModelRouteDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsIn(AUTH_TYPES)
  authType!: 'api_key' | 'subscription' | 'local';

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  keyLabel?: string;
}

export class AgentNameParamDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Invalid agent name' })
  agentName!: string;
}

export class TierParamDto {
  @IsIn(TIER_SLOTS)
  tier!: string;
}

export class ProviderParamDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;
}

export class ConnectProviderDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(KNOWN_PROVIDER_IDS, {
    message: `provider must be one of: ${KNOWN_PROVIDER_IDS.join(', ')}`,
  })
  provider!: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: AuthType;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  base_url?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  label?: string;
}

export class AgentProviderParamDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Invalid agent name' })
  agentName!: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;
}

export class AgentProviderKeyParamDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Invalid agent name' })
  agentName!: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  label!: string;
}

export class RemoveProviderQueryDto {
  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  label?: string;
}

export class RenameProviderKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  newLabel!: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription';
}

export class ReorderProviderKeysDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  labels!: string[];

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription';
}

export class SetOverrideDto {
  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  provider?: string;

  @IsOptional()
  @IsIn(AUTH_TYPES)
  authType?: 'api_key' | 'subscription' | 'local';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PROVIDER_KEY_LABEL_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  providerKeyLabel?: string;

  // Optional route field. When clients send this, it takes precedence over
  // the flat (model, provider, authType) above and is the unambiguous shape.
  // `route.keyLabel` carries the same data as `providerKeyLabel` above when
  // present.
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelRouteDto)
  route?: ModelRouteDto;
}

export class CopilotPollDto {
  @IsString()
  @IsNotEmpty()
  deviceCode!: string;
}

export class SetFallbacksDto {
  @IsArray()
  @ArrayMaxSize(MAX_FALLBACKS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  models!: string[];

  // Optional structured routes. When present, takes precedence over `models`
  // above and is what we persist to fallback_routes. Length must match
  // `models` so the dual-write stays consistent. Each entry's `keyLabel`
  // pins which provider key is used for that fallback.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FALLBACKS)
  @ValidateNested({ each: true })
  @Type(() => ModelRouteDto)
  routes?: ModelRouteDto[];
}

export class SetResponseModeDto {
  @IsOptional()
  @IsIn(RESPONSE_MODES)
  response_mode?: ResponseMode;

  @IsOptional()
  @IsIn(RESPONSE_MODES)
  responseMode?: ResponseMode;
}

export function responseModeFromDto(body: SetResponseModeDto): ResponseMode | undefined {
  return body.response_mode ?? body.responseMode;
}

export class UpdateAutofixDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateRecordingDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
