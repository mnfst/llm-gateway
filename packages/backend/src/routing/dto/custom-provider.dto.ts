import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsArray,
  ValidateNested,
  Matches,
  MaxLength,
  MinLength,
  ArrayMinSize,
  ArrayMaxSize,
  IsUrl,
  IsIn,
  Min,
  IsBoolean,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  CUSTOM_PROVIDER_ALIAS_MAX_LENGTH,
  CUSTOM_PROVIDER_ALIAS_MESSAGE,
  CUSTOM_PROVIDER_ALIAS_PATTERN,
  normalizeCustomProviderAlias,
} from 'manifest-shared';

/**
 * Public prefix of the provider's model ids (`<alias>/<model_name>`).
 * Normalised to lowercase; an empty string clears it. Omitted on create
 * derives one from the name; omitted on update leaves it untouched.
 */
function AliasField(): PropertyDecorator {
  const decorators = [
    IsOptional(),
    Transform(({ value }) =>
      typeof value === 'string' ? normalizeCustomProviderAlias(value) : value,
    ),
    IsString(),
    MaxLength(CUSTOM_PROVIDER_ALIAS_MAX_LENGTH),
    Matches(CUSTOM_PROVIDER_ALIAS_PATTERN, { message: CUSTOM_PROVIDER_ALIAS_MESSAGE }),
  ];
  return (target, propertyKey) => {
    for (const decorator of decorators) decorator(target, propertyKey);
  };
}

export const CUSTOM_PROVIDER_API_KINDS = ['openai', 'anthropic'] as const;
export type CustomProviderApiKindDto = (typeof CUSTOM_PROVIDER_API_KINDS)[number];
export const CUSTOM_PROVIDER_MODEL_LIMIT = 500;

export class CustomProviderModelDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model_name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  input_price_per_million_tokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  output_price_per_million_tokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  context_window?: number;

  @IsOptional()
  @IsBoolean()
  price_estimated?: boolean;
}

export class CreateCustomProviderDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9 ._-]+$/, {
    message: 'Name can only contain letters, numbers, spaces, dots, hyphens, and underscores',
  })
  name!: string;

  @AliasField()
  alias?: string | null;

  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false, require_protocol: true }, { message: 'Must be a valid URL' })
  base_url!: string;

  @IsOptional()
  @IsIn(CUSTOM_PROVIDER_API_KINDS, { message: 'api_kind must be "openai" or "anthropic"' })
  api_kind?: CustomProviderApiKindDto;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CUSTOM_PROVIDER_MODEL_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => CustomProviderModelDto)
  models!: CustomProviderModelDto[];
}

export class ProbeCustomProviderDto {
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false, require_protocol: true }, { message: 'Must be a valid URL' })
  base_url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  provider_name?: string;

  @IsOptional()
  @IsIn(CUSTOM_PROVIDER_API_KINDS, { message: 'api_kind must be "openai" or "anthropic"' })
  api_kind?: CustomProviderApiKindDto;

  @IsOptional()
  @IsString()
  apiKey?: string;
}

export class UpdateCustomProviderDto {
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Type(() => Number)
  stream_warmup_ms?: number | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9 ._-]+$/, {
    message: 'Name can only contain letters, numbers, spaces, dots, hyphens, and underscores',
  })
  name?: string;

  @AliasField()
  alias?: string | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false, require_protocol: true }, { message: 'Must be a valid URL' })
  base_url?: string;

  @IsOptional()
  @IsIn(CUSTOM_PROVIDER_API_KINDS, { message: 'api_kind must be "openai" or "anthropic"' })
  api_kind?: CustomProviderApiKindDto;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CUSTOM_PROVIDER_MODEL_LIMIT)
  @ValidateNested({ each: true })
  @Type(() => CustomProviderModelDto)
  models?: CustomProviderModelDto[];
}
