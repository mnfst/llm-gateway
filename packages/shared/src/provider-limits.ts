/**
 * Safety ceiling for active credentials on one provider/authentication type.
 *
 * This is intentionally high enough not to constrain legitimate multi-account
 * setups while still guarding against accidental bulk credential creation.
 */
export const MAX_KEYS_PER_PROVIDER = 50;
