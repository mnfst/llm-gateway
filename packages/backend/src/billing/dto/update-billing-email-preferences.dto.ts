import { IsBoolean } from 'class-validator';

export class UpdateBillingEmailPreferencesDto {
  @IsBoolean()
  usageAlerts!: boolean;
}
