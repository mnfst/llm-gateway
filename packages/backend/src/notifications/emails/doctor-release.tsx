import { getEmailAssetUrl } from '../../common/utils/dashboard-url';
import * as React from 'react';
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Preview,
  Hr,
  Link,
  Img,
  Button,
} from '@react-email/components';

export interface DoctorReleaseProps {
  /** The dashboard the reader lands on. */
  appUrl: string;
  /** The tutorial article (blog). Optional until published. */
  tutorialUrl?: string;
  logoUrl?: string;
  /** The Autofix gradient sparkle mark (hosted PNG). */
  autofixIconUrl?: string;
}

/**
 * The Autofix release announcement, sent once to every waitlist member when
 * the Doctor version ships. Copy rules: recovery vocabulary (a fallback is a
 * retry, an autofix produces an attempt), no em dashes, short sentences.
 */
export function DoctorReleaseEmail(props: DoctorReleaseProps) {
  const {
    appUrl,
    tutorialUrl,
    logoUrl = getEmailAssetUrl('manifest-logo.png', props.appUrl),
    autofixIconUrl = getEmailAssetUrl('autofix-icon-email.png', props.appUrl),
  } = props;

  return (
    <Html>
      <Head />
      <Preview>
        Autofix is live on your account. Your failing requests can now repair themselves.
      </Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={logoSection}>
            <Img src={logoUrl} alt="Manifest LLM Gateway" width="174" height="32" style={logoImg} />
          </Section>

          <Section style={card}>
            <Section style={badgeContainer}>
              <Text style={newLine}>
                <span style={newLabel}>New:</span>{' '}
                <Img src={autofixIconUrl} alt="" width="18" height="18" style={autofixIcon} />{' '}
                <span style={autofixName}>Autofix</span>
              </Text>
            </Section>

            <Text style={heading}>Autofix is live on your account</Text>

            <Text style={paragraph}>
              You joined the waitlist. Here it is: Autofix shipped today, and it is already running
              on your account. You have nothing to turn on.
            </Text>

            <Text style={paragraph}>
              From now on, when a provider rejects one of your requests with a fixable error, a
              renamed parameter, an unsupported field, a deprecated model, Manifest repairs the
              request and sends it again. Your agent gets its answer. You see the whole story in
              your dashboard: the failure, the fix, the retry.
            </Text>

            <Text style={paragraph}>
              Autofix learns from real traffic. Each new error we patch works for every account, so
              the share of requests it can repair grows week after week.
            </Text>

            <Section style={buttonSection}>
              <Button href={appUrl} style={buttonPrimary}>
                Open your dashboard
              </Button>
              {tutorialUrl ? (
                <Button href={tutorialUrl} style={buttonSecondary}>
                  How Autofix works
                </Button>
              ) : null}
            </Section>

            <Hr style={hr} />

            <Text style={footer}>
              You are receiving this email because you joined the Autofix waitlist on Manifest.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const brandBg = '#faf9f6';
const brandCardBg = '#ffffff';
const brandBorder = '#e8e5df';
const brandFont =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const brandInk = '#1a1a1a';
const brandMuted = '#6b6b6b';

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

const badgeContainer: React.CSSProperties = {
  marginBottom: '16px',
};

const newLine: React.CSSProperties = {
  fontSize: '14px',
  margin: 0,
  lineHeight: '18px',
};

const newLabel: React.CSSProperties = {
  color: brandInk,
  fontWeight: 600,
};

const autofixIcon: React.CSSProperties = {
  display: 'inline-block',
  verticalAlign: 'middle',
  borderRadius: '4px',
  margin: '0 2px',
};

const autofixName: React.CSSProperties = {
  color: brandInk,
  fontWeight: 700,
};

const heading: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 700,
  color: brandInk,
  margin: '0 0 16px',
  lineHeight: '1.3',
};

const paragraph: React.CSSProperties = {
  fontSize: '14px',
  lineHeight: '1.6',
  color: brandInk,
  margin: '0 0 16px',
};

const buttonSection: React.CSSProperties = {
  textAlign: 'left' as const,
  margin: '28px 0 20px',
};

const buttonBase: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 600,
  borderRadius: '8px',
  padding: '12px 24px',
  textDecoration: 'none',
};

const buttonPrimary: React.CSSProperties = {
  ...buttonBase,
  backgroundColor: brandInk,
  color: '#ffffff',
  marginRight: '12px',
};

const buttonSecondary: React.CSSProperties = {
  ...buttonBase,
  backgroundColor: brandCardBg,
  color: brandInk,
  border: `1px solid ${brandBorder}`,
};

const hr: React.CSSProperties = {
  borderColor: brandBorder,
  margin: '24px 0 16px',
};

const footer: React.CSSProperties = {
  fontSize: '12px',
  color: brandMuted,
  margin: 0,
};
