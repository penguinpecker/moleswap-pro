/**
 * Get referral code from URL query params
 */
export const getReferralCodeFromURL = (): string | null => {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  return params.get('ref');
};

/**
 * Store referral code in cookie (persistent across sessions)
 */
export const storeReferralCode = (code: string): void => {
  if (typeof window === 'undefined') return;
  // Store in cookie for 30 days
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  document.cookie = `referralCode=${encodeURIComponent(code)}; expires=${expires.toUTCString()}; path=/; samesite=lax`;
};

/**
 * Get stored referral code from cookie
 */
export const getStoredReferralCode = (): string | null => {
  if (typeof window === 'undefined') return null;

  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'referralCode') {
      return decodeURIComponent(value);
    }
  }
  return null;
};

/**
 * Clear stored referral code
 */
export const clearStoredReferralCode = (): void => {
  if (typeof window === 'undefined') return;
  // Set cookie to expire immediately
  document.cookie = 'referralCode=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; samesite=lax';
};

/**
 * Legacy functions for backwards compatibility
 */
export const getReferrerFromURL = getReferralCodeFromURL;
export const storeReferrer = storeReferralCode;
export const getStoredReferrer = getStoredReferralCode;
export const clearStoredReferrer = clearStoredReferralCode;

/**
 * Store invite code in localStorage
 */
export const storeInviteCode = (code: string): void => {
  if (typeof window === 'undefined') return;
  localStorage.setItem('inviteCode', code);
};

/**
 * Get stored invite code
 */
export const getStoredInviteCode = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('inviteCode');
};

/**
 * Clear stored invite code
 */
export const clearStoredInviteCode = (): void => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('inviteCode');
};
