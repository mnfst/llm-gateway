import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CompleteDiscoveryDto } from './complete-discovery.dto';

function validate(payload: Record<string, unknown>) {
  const dto = plainToInstance(CompleteDiscoveryDto, payload);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('CompleteDiscoveryDto', () => {
  it('accepts the complete discovery payload', () => {
    expect(
      validate({
        name: 'Jane Doe',
        email: 'jane@example.com',
        projectType: 'ai_agent',
        companySize: '21-100',
      }),
    ).toHaveLength(0);
  });

  it('accepts an empty payload for Skip', () => {
    expect(validate({})).toHaveLength(0);
  });

  it('rejects invalid select values and emails', () => {
    const errors = validate({
      email: 'not-an-email',
      projectType: 'unexpected',
      companySize: 'huge',
    });

    expect(errors.map((error) => error.property).sort()).toEqual(
      ['email', 'projectType', 'companySize'].sort(),
    );
  });

  it('rejects unknown fields', () => {
    expect(validate({ newsletter: true }).map((error) => error.property)).toContain('newsletter');
  });
});
