import { Title } from '@solidjs/meta';
import type { Component } from 'solid-js';

const OauthError: Component = () => (
  <>
    <Title>MCP authorization error - Manifest</Title>
    <div class="auth-header">
      <h1 class="auth-header__title">Cannot authorize this MCP client</h1>
      <p class="auth-header__subtitle">
        The client requested a callback URL that is not in its registered client metadata. Check the
        client configuration and try again.
      </p>
    </div>
    <p class="auth-form__error" role="alert">
      invalid_redirect_uri
    </p>
  </>
);

export default OauthError;
