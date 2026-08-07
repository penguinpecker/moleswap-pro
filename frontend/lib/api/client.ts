/**
 * API Client for MoleSwap Backend.
 * Twitter users are authenticated via backend JWT cookie.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

interface ApiResponse<T = any> {
  data?: T;
  error?: string;
}

/**
 * Generic fetch wrapper with error handling.
 * Uses JWT cookie for authentication (set by backend after Twitter OAuth).
 */
async function apiCall<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };

    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
      credentials: 'include', // Include cookies (JWT token)
    });

    const data = await response.json();

    if (!response.ok) {
      return { error: data.error || 'An error occurred' };
    }

    return { data };
  } catch (error) {
    console.error('API call error:', error);
    return { error: 'Network error occurred' };
  }
}

/**
 * Auth API (Supabase handles authentication now)
 */
export const authAPI = {
  /**
   * Get current user info
   */
  getCurrentUser: () => apiCall('/api/auth/me'),
};

/**
 * Waitlist API
 */
export const waitlistAPI = {
  /**
   * Verify invite code
   */
  verifyInviteCode: (inviteCode: string, referrerCode?: string) =>
    apiCall('/api/waitlist/verify', {
      method: 'POST',
      body: JSON.stringify({ inviteCode, referrerCode }),
    }),

  /**
   * Skip invite code requirement
   */
  skipInviteCode: () =>
    apiCall('/api/waitlist/skip', {
      method: 'POST',
    }),
};

/**
 * XP API
 */
export const xpAPI = {
  /**
   * Award XP for following on Twitter
   */
  awardFollowXP: () =>
    apiCall('/api/xp/follow', {
      method: 'POST',
    }),

  /**
   * Award XP for playing game
   */
  awardGameXP: (moleCount: number, xpEarned: number) =>
    apiCall('/api/xp/game', {
      method: 'POST',
      body: JSON.stringify({ moleCount, xpEarned }),
    }),

  /**
   * Award XP for sharing tweet
   */
  awardShareTweetXP: () =>
    apiCall('/api/xp/share-tweet', {
      method: 'POST',
    }),

  /**
   * Get XP statistics
   */
  getXPStats: () => apiCall('/api/xp/stats'),
};

/**
 * Referral API
 */
export const referralAPI = {
  /**
   * Process referral code after user signup
   */
  processReferralCode: (referralCode: string) =>
    apiCall('/api/referral/process', {
      method: 'POST',
      body: JSON.stringify({ referralCode }),
    }),

  /**
   * Get referral link
   */
  getReferralLink: () => apiCall('/api/referral/link'),

  /**
   * Get referral statistics
   */
  getReferralStats: () => apiCall('/api/referral/stats'),
};
