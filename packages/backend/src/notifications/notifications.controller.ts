import { Controller, Get, Post, Patch, Delete, Query, Param, Body, Logger } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { NotificationRulesService } from './services/notification-rules.service';
import { NotificationLogService } from './services/notification-log.service';
import { EmailProviderConfigService } from './services/email-provider-config.service';
import { NotificationCronService } from './services/notification-cron.service';
import { CreateNotificationRuleDto, UpdateNotificationRuleDto } from './dto/notification-rule.dto';
import {
  SetEmailProviderDto,
  TestEmailProviderDto,
  TestSavedEmailProviderDto,
} from './dto/set-email-provider.dto';
import { SetNotificationEmailDto } from './dto/set-notification-email.dto';

@Controller('api/v1/notifications')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly rulesService: NotificationRulesService,
    private readonly notificationLog: NotificationLogService,
    private readonly emailProviderConfigService: EmailProviderConfigService,
    private readonly cronService: NotificationCronService,
  ) {}

  @Get('email-provider')
  async getEmailProvider(@TenantCtx() ctx: TenantContext) {
    const config = await this.emailProviderConfigService.getConfig(ctx.tenantId);
    return config ?? { configured: false };
  }

  @Post('email-provider/test')
  async testEmailProvider(@TenantCtx() _ctx: TenantContext, @Body() body: TestEmailProviderDto) {
    return this.emailProviderConfigService.testConfig(
      { provider: body.provider, apiKey: body.apiKey, domain: body.domain },
      body.to,
    );
  }

  @Post('email-provider/test-saved')
  async testSavedEmailProvider(
    @TenantCtx() ctx: TenantContext,
    @Body() body: TestSavedEmailProviderDto,
  ) {
    return this.emailProviderConfigService.testSavedConfig(ctx.tenantId, body.to);
  }

  @Post('email-provider')
  async setEmailProvider(@TenantCtx() ctx: TenantContext, @Body() body: SetEmailProviderDto) {
    return this.emailProviderConfigService.upsert(ctx, body);
  }

  @Delete('email-provider')
  async removeEmailProvider(@TenantCtx() ctx: TenantContext) {
    await this.emailProviderConfigService.remove(ctx.tenantId);
    return { ok: true };
  }

  @Get('notification-email')
  async getNotificationEmail(@TenantCtx() ctx: TenantContext) {
    const email = await this.emailProviderConfigService.getNotificationEmail(ctx.tenantId);
    return { email };
  }

  @Post('notification-email')
  async setNotificationEmail(
    @TenantCtx() ctx: TenantContext,
    @Body() body: SetNotificationEmailDto,
  ) {
    await this.emailProviderConfigService.setNotificationEmail(ctx.tenantId, body.email);
    return { saved: true };
  }

  @Post('trigger-check')
  async triggerCheck(@TenantCtx() ctx: TenantContext) {
    this.logger.log('Manual notification check triggered');
    const triggered = await this.cronService.checkThresholds(ctx.tenantId ?? undefined);
    return { triggered, message: `${triggered} notification(s) triggered` };
  }

  @Get('logs')
  async getLogs(@Query('agent_name') agentName: string, @TenantCtx() ctx: TenantContext) {
    return this.notificationLog.getLogsForAgent(ctx.tenantId, agentName);
  }

  @Get()
  async listRules(@Query('agent_name') agentName: string, @TenantCtx() ctx: TenantContext) {
    return this.rulesService.listRules(ctx.tenantId, agentName);
  }

  @Post()
  async createRule(@Body() dto: CreateNotificationRuleDto, @TenantCtx() ctx: TenantContext) {
    return this.rulesService.createRule(ctx.tenantId, dto);
  }

  @Patch(':id')
  async updateRule(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationRuleDto,
    @TenantCtx() ctx: TenantContext,
  ) {
    return this.rulesService.updateRule(ctx.tenantId, id, dto);
  }

  @Delete(':id')
  async deleteRule(@Param('id') id: string, @TenantCtx() ctx: TenantContext) {
    await this.rulesService.deleteRule(ctx.tenantId, id);
    return { deleted: true };
  }
}
