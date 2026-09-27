import { DebugSentryController } from '../debug-sentry.controller';

describe('DebugSentryController', () => {
  it('throws a test error', () => {
    expect(() => new DebugSentryController().getError()).toThrow('My first Sentry error!');
  });
});
