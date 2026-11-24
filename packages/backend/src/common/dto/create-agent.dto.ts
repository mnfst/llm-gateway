import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { AGENT_CATEGORIES, AGENT_PLATFORMS } from 'manifest-shared';

export class CreateAgentDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9 _-]+$/, {
    message: 'Agent name must contain only letters, numbers, spaces, dashes, and underscores',
  })
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn([...AGENT_CATEGORIES])
  agent_category?: string;

  @IsOptional()
  @IsString()
  @IsIn([...AGENT_PLATFORMS])
  agent_platform?: string;

  /** Explicit Autofix choice at creation. Omit to inherit the mode default. */
  @IsOptional()
  @IsBoolean()
  autofix_enabled?: boolean;

  /** Explicit recording choice at creation. Omit to keep the column default. */
  @IsOptional()
  @IsBoolean()
  record_messages?: boolean;
}
