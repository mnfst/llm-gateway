import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

import {
  AUTH_TYPES,
  type AuthType,
  type JsonValue,
  type RequestParamDefaults,
} from 'manifest-shared';

export type ModelParamsBodyDto = RequestParamDefaults;

const MAX_REQUEST_PARAM_DEPTH = 100;

@ValidatorConstraint({ name: 'requestParamDefaults', async: false })
class RequestParamDefaultsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isJsonObject(value);
  }

  defaultMessage(): string {
    return 'params must be a JSON object';
  }
}

export class SetModelParamsBodyDto {
  @IsString()
  @IsNotEmpty()
  scope!: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsIn(AUTH_TYPES)
  authType!: AuthType;

  @IsString()
  @IsNotEmpty()
  model!: string;

  // Always required on PUT — to clear params, call DELETE instead. Routing
  // through one path per intent keeps the storage model simple (no "save
  // empty == delete" magic at the controller layer).
  //
  // Arbitrary keys are intentional because provider params are MPS-backed.
  // This DTO validates JSON shape; ModelParamsController.assertCompatibleParams
  // validates each known value against the route's specs before saving.
  @IsObject()
  @Validate(RequestParamDefaultsConstraint)
  params!: RequestParamDefaults;
}

export class DeleteModelParamsBodyDto {
  @IsString()
  @IsNotEmpty()
  scope!: string;

  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsIn(AUTH_TYPES)
  authType!: AuthType;

  @IsString()
  @IsNotEmpty()
  model!: string;
}

// Query params for the per-model spec lookup. Provider/auth/model identify one
// route's configurable parameters; the UI fetches this on dialog open instead
// of downloading the whole catalog on page boot.
export class ModelParamSpecsQueryDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsIn(AUTH_TYPES)
  authType!: AuthType;

  @IsString()
  @IsNotEmpty()
  model!: string;
}

// Tier-addressed params (CLI + MCP): a route is named by tier + model instead
// of the stored (scope, provider, authType, model) identity.
export class TierModelParamsPathDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Invalid agent name' })
  agentName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tier!: string;
}

export class TierModelParamsQueryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  model?: string;
}

const MAX_PARAM_CHANGES = 50;

export class UpdateTierModelParamsBodyDto {
  // Keys are param paths (`reasoning.effort`), values the JSON to store.
  @IsOptional()
  @IsObject()
  @Validate(RequestParamDefaultsConstraint)
  set?: Record<string, JsonValue>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PARAM_CHANGES)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  unset?: string[];
}

function isJsonObject(value: unknown, depth = 0): value is Record<string, unknown> {
  if (depth > MAX_REQUEST_PARAM_DEPTH) return false;
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_REQUEST_PARAM_DEPTH) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isJsonObject(value, depth);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
