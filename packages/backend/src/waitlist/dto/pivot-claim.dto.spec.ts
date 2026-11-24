import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PivotClaimDto } from './pivot-claim.dto';

function validate(payload: Record<string, unknown>) {
  const dto = plainToInstance(PivotClaimDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('PivotClaimDto', () => {
  it('accepts a valid email and trims surrounding whitespace', () => {
    const { dto, errors } = validate({ email: '  jane@example.com ' });
    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('jane@example.com');
  });

  it('rejects an invalid email', () => {
    const { errors } = validate({ email: 'not-an-email' });
    expect(errors.map((error) => error.property)).toContain('email');
  });

  it('leaves non-string values to the email validator', () => {
    const { errors } = validate({ email: 42 });
    expect(errors.map((error) => error.property)).toContain('email');
  });

  it('rejects unknown fields', () => {
    const { errors } = validate({ email: 'jane@example.com', newsletter: true });
    expect(errors.map((error) => error.property)).toContain('newsletter');
  });

  it('rejects an explicit null source; only omission earns the default', () => {
    const { errors } = validate({ email: 'a@b.co', source: null });
    expect(errors.map((error) => error.property)).toContain('source');
  });

  it('accepts the two claim sources and rejects anything else', () => {
    expect(validate({ email: 'a@b.co', source: 'cloud' }).errors).toHaveLength(0);
    expect(validate({ email: 'a@b.co', source: 'self-hosted' }).errors).toHaveLength(0);
    const { errors } = validate({ email: 'a@b.co', source: 'website' });
    expect(errors.map((error) => error.property)).toContain('source');
  });
});
