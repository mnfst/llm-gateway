const PREFIX = 'manifest_plan_chosen_';

export function markPlanChosen(userId: string): void {
  try {
    localStorage.setItem(`${PREFIX}${userId}`, '1');
  } catch {
    /* storage full or unavailable */
  }
}

export function hasPlanBeenChosen(userId: string): boolean {
  try {
    return localStorage.getItem(`${PREFIX}${userId}`) === '1';
  } catch {
    return false;
  }
}

export function clearPlanChosen(userId: string): void {
  try {
    localStorage.removeItem(`${PREFIX}${userId}`);
  } catch {
    /* noop */
  }
}
