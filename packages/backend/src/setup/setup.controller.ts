import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CreateAdminDto } from './dto/create-admin.dto';
import { SetupService } from './setup.service';

@Controller('api/v1/setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Public()
  @Get('status')
  async getStatus(): Promise<{
    needsSetup: boolean;
    socialProviders: string[];
    isSelfHosted: boolean;
    ollamaAvailable: boolean;
    localLlmHost: string;
    emailConfigured: boolean;
    mcpEnabled: boolean;
  }> {
    const selfHosted = this.setupService.isSelfHosted();
    const ollamaAvailable = selfHosted ? await this.setupService.isOllamaAvailable() : false;
    return {
      needsSetup: await this.setupService.needsSetup(),
      socialProviders: this.setupService.getEnabledSocialProviders(),
      isSelfHosted: selfHosted,
      ollamaAvailable,
      localLlmHost: this.setupService.getLocalLlmHost(),
      emailConfigured: this.setupService.isEmailConfigured(),
      mcpEnabled: this.setupService.isMcpEnabled(),
    };
  }

  @Public()
  @Post('admin')
  @HttpCode(HttpStatus.CREATED)
  async createAdmin(@Body() dto: CreateAdminDto): Promise<{ ok: true }> {
    await this.setupService.createFirstAdmin(dto);
    return { ok: true };
  }
}
