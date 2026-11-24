const PREFIX = 'manifest_onboarding_done_';

export function markOnboardingDone(userId: string): void {
  try {
    localStorage.setItem(`${PREFIX}${userId}`, '1');
  } catch {
    /* storage full or unavailable */
  }
}

export function hasOnboardingBeenDone(userId: string): boolean {
  try {
    return localStorage.getItem(`${PREFIX}${userId}`) === '1';
  } catch {
    return false;
  }
}
