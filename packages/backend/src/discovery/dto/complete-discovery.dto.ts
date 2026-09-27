import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const PROJECT_TYPES = [
  'ai_product',
  'ai_agent',
  'internal_tool',
  'workflow_platform',
  'personal_project',
  'other',
] as const;

const COMPANY_SIZES = ['not_for_work', '1-20', '21-100', '101-500', '501-1000', '1000+'] as const;

/** Optional fields from the one-time self-hosted discovery form. */
export class CompleteDiscoveryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsIn(PROJECT_TYPES)
  projectType?: string;

  @IsOptional()
  @IsIn(COMPANY_SIZES)
  companySize?: string;
}
