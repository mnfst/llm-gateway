import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Body of the "Custom development" contact form in the dashboard header. */
export class ServicesContactDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  message!: string;
}
