import { getEmailAssetUrl } from '../../common/utils/dashboard-url';
import * as React from 'react';
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Button,
  Preview,
  Hr,
  Img,
  Link,
} from '@react-email/components';

export interface ResetPasswordEmailProps {
  userName: string;
  resetUrl: string;
  logoUrl?: string;
}

export function ResetPasswordEmail(props: ResetPasswordEmailProps) {
  const { userName, resetUrl, logoUrl = getEmailAssetUrl('manifest-logo.png') } = props;

  return (
    <Html>
      <Head />
      <Preview>Reset your Manifest password</Preview>
      <Body style={body}>
        <Container style={container}>
          {/* Logo */}
          <Section style={logoSection}>
            <Img src={logoUrl} alt="Manifest LLM Gateway" width="174" height="32" style={logoImg} />
          </Section>

          {/* Main content */}
          <Section style={card}>
            <Text style={heading}>Reset your password</Text>
            <Text style={paragraph}>
              Hi {userName}, we received a request to reset your password. Click the button below to
              choose a new one.
            </Text>

            <Section style={buttonContainer}>
              <Button style={button} href={resetUrl}>
                Reset password
              </Button>
            </Section>

            <Text style={hint}>
              This link expires in 1 hour. If you didn't request a password reset, you can safely
              ignore this email.
            </Text>
          </Section>

          {/* Fallback link */}
          <Section style={fallbackSection}>
            <Text style={fallbackText}>
              If the button above doesn't work, copy and paste this link into your browser:
            </Text>
            <Text style={fallbackUrl}>{resetUrl}</Text>
          </Section>

          {/* Footer */}
          <Hr style={divider} />
          <Section style={footer}>
            <Text style={footerMuted}>
              © 2026 MNFST Inc. All rights reserved.{' '}
              <Link href="https://manifest.build" style={footerLink}>
                manifest.build
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/* ── Brand tokens ──────────────────────────────────── */
const brandBg = '#f8f6f1';
const brandCardBg = '#ffffff';
const brandPrimary = '#0f172a';
const brandPrimaryFg = '#f9f8f5';
const brandFg = '#020817';
const brandMuted = '#64748b';
const brandBorder = '#e5dfd6';
const brandFont =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/* ── Styles ────────────────────────────────────────── */
const body: React.CSSProperties = {
  backgroundColor: brandBg,
  fontFamily: brandFont,
  margin: 0,
  padding: 0,
};

const container: React.CSSProperties = {
  maxWidth: '520px',
  margin: '0 auto',
  padding: '40px 20px',
};

const logoSection: React.CSSProperties = {
  textAlign: 'center' as const,
  paddingBottom: '32px',
};

const logoImg: React.CSSProperties = {
  margin: '0 auto',
};

const card: React.CSSProperties = {
  backgroundColor: brandCardBg,
  borderRadius: '12px',
  padding: '40px 36px',
  border: `1px solid ${brandBorder}`,
};

const heading: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 700,
  letterSpacing: '-0.02em',
  color: brandFg,
  margin: '0 0 12px',
  lineHeight: '1.3',
};

const paragraph: React.CSSProperties = {
  fontSize: '15px',
  lineHeight: '1.6',
  color: '#374151',
  margin: '0 0 28px',
};

const buttonContainer: React.CSSProperties = {
  textAlign: 'center' as const,
  margin: '0 0 28px',
};

const button: React.CSSProperties = {
  backgroundColor: brandPrimary,
  color: brandPrimaryFg,
  fontSize: '14px',
  fontWeight: 600,
  padding: '14px 28px',
  borderRadius: '8px',
  textDecoration: 'none',
  display: 'inline-block',
  lineHeight: '1',
};

const hint: React.CSSProperties = {
  fontSize: '13px',
  lineHeight: '1.5',
  color: brandMuted,
  margin: 0,
};

const fallbackSection: React.CSSProperties = {
  padding: '24px 0 0',
};

const fallbackText: React.CSSProperties = {
  fontSize: '12px',
  color: brandMuted,
  margin: '0 0 6px',
};

const fallbackUrl: React.CSSProperties = {
  fontSize: '12px',
  color: brandMuted,
  margin: 0,
  wordBreak: 'break-all' as const,
};

const divider: React.CSSProperties = {
  borderColor: brandBorder,
  borderTop: 'none',
  margin: '32px 0 24px',
};

const footer: React.CSSProperties = {
  textAlign: 'center' as const,
};

const footerMuted: React.CSSProperties = {
  fontSize: '12px',
  color: '#94a3b8',
  margin: 0,
};

const footerLink: React.CSSProperties = {
  color: '#94a3b8',
  textDecoration: 'underline',
};
