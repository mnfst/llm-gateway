export interface SubscriptionCapabilities {
  maxContextWindow: number;
  modelContextWindows?: Readonly<Record<string, number>>;
  supportsPromptCaching: boolean;
  supportsBatching: boolean;
}

export interface SubscriptionProviderConfig {
  supportsSubscription: true;
  subscriptionLabel: string;
  subscriptionKeyPlaceholder?: string;
  subscriptionCommand?: string;
  subscriptionAuthMode?: 'popup_oauth' | 'device_code' | 'token';
  subscriptionTokenPrefix?: string;
  knownModels?: readonly string[];
  /**
   * How a known model is considered covered by live subscription discovery:
   * `prefix` (default) accepts a more specific discovered variant, while
   * `exact` requires the curated model ID itself to be present.
   */
  knownModelsMatch?: 'prefix' | 'exact';
  subscriptionCapabilities?: Readonly<SubscriptionCapabilities>;
}
