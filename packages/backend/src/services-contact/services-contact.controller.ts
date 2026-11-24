import { BadGatewayException, Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { ServicesContactDto } from './dto/services-contact.dto';

/**
 * Endpoint of the manifest.build Vercel function (mnfst/website api/contact.js)
 * that emails each services request to the Manifest team. Nothing is stored.
 */
export const SERVICES_CONTACT_URL = 'https://manifest.build/api/contact/';

/**
 * Relays the dashboard's "Custom development" form to manifest.build. The
 * browser posts same-origin, so the dashboard CSP stays `connect-src 'self'`;
 * the backend makes the outbound call, cloud and self-hosted alike.
 */
@Controller('api/v1/services')
export class ServicesContactController {
  @Post('contact')
  @HttpCode(HttpStatus.OK)
  async contact(@Body() dto: ServicesContactDto): Promise<{ ok: true }> {
    const source = isSelfHosted() ? 'dashboard-self-hosted' : 'dashboard-cloud';
    let res: Response;
    try {
      res = await fetch(SERVICES_CONTACT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...dto, source }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BadGatewayException('manifest.build is unreachable');
    }
    if (!res.ok) throw new BadGatewayException('manifest.build did not send the email');
    return { ok: true };
  }
}
