import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import type {
  ErrorPageFaqItem,
  ErrorPageRelatedLink,
  ErrorPageStats,
} from '../../entities/public-error-page.entity';

/**
 * Payload the Peacock CMS pushes to publish (or re-publish/refresh) a page.
 * The global ValidationPipe runs with whitelist + forbidNonWhitelisted, so every
 * accepted field must be declared here; nested objects are validated loosely
 * (the push is a trusted, secret-guarded internal call, and the service
 * re-scrubs + re-validates the k-anonymity floor defensively).
 */
export class UpsertErrorPageDto {
  @IsString() slug!: string;
  @IsString() cluster_key!: string;
  @IsString() provider!: string;
  @IsOptional() @IsString() provider_label?: string;
  @IsOptional() @IsInt() http_status?: number | null;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() category_label?: string;
  @IsString() title!: string;
  @IsString() meta_description!: string;
  @IsString() h1!: string;
  @IsOptional() @IsString() body_what?: string;
  @IsOptional() @IsString() body_fix?: string;
  @IsOptional() @IsString() body_manifest?: string;
  @IsOptional() @IsString() sample_message?: string;
  @IsOptional() @IsArray() faq?: ErrorPageFaqItem[];
  @IsObject() stats!: ErrorPageStats;
  @IsOptional() @IsArray() related?: ErrorPageRelatedLink[];
  @IsOptional() @IsBoolean() noindex?: boolean;
}
