# MoleSwap Frontend - Backend Integration

This document describes the backend integration for the MoleSwap frontend application.

## Overview

The frontend now integrates with a complete Express.js backend for:
- Twitter OAuth 2.0 authentication
- Invite code verification
- XP tracking (follow, game, referrals)
- Referral link generation and tracking

## Environment Setup

Create `.env.local` in the project root:

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_APP_URL=http://localhost:3001
```

## API Client

The API client is located at `lib/api/client.ts` and provides:

### Auth API
- `authAPI.getTwitterAuthUrl(inviteCode?, referredBy?)` - Get Twitter OAuth URL
- `authAPI.getCurrentUser()` - Get current user info
- `authAPI.logout()` - Logout user

### Waitlist API
- `waitlistAPI.verifyInviteCode(code)` - Verify invite code

### XP API
- `xpAPI.awardFollowXP()` - Award XP for following
- `xpAPI.awardGameXP(moleCount, xpEarned)` - Award game XP
- `xpAPI.getXPStats()` - Get XP statistics

### Referral API
- `referralAPI.getReferralLink()` - Get user's referral link
- `referralAPI.getReferralStats()` - Get referral statistics

## Updated Pages

### 1. Home Page (`app/page.tsx`)
- Captures referral parameter from URL (`?ref=username`)
- Stores referrer in localStorage for later use

### 2. Waitlist Page (`screens/waitlist/index.tsx`)
- Verifies invite code with backend
- Shows loading/error/success states
- Stores valid code for Twitter OAuth flow
- Redirects to connect-twitter on success

### 3. Connect Twitter Page (`screens/connect-twitter/index.tsx`)
- Retrieves stored invite code and referrer
- Redirects to backend Twitter OAuth
- Passes invite code and referrer as query params

### 4. Earn XP Page (`screens/earn-xp/index.tsx`)
- Fetches user data and XP stats on load
- Shows total XP in header
- **Follow Section**:
  - Opens Twitter follow link
  - "Verify" button to claim 500 XP
  - Shows completion status
- **Share Section**:
  - Generates unique referral link
  - Opens Twitter share with referral link
  - Awards 1000 XP per successful referral
- **Game Section**:
  - Displays remaining game XP
  - Shows checkmark when 1500 XP reached

### 5. Whack-a-Mole Modal (`components/WhackAMoleModal.tsx`)
- Tracks mole hits during game
- Submits XP to backend when game ends
- Enforces 1500 XP maximum
- Shows submission status

## Utility Functions

### Referral Utils (`lib/utils/referral.ts`)
- `getReferrerFromURL()` - Extract referrer from URL
- `storeReferrer(username)` - Store referrer in localStorage
- `getStoredReferrer()` - Get stored referrer
- `storeInviteCode(code)` - Store invite code
- `getStoredInviteCode()` - Get stored invite code
- `clearStoredReferrer()` / `clearStoredInviteCode()` - Clear stored values

## User Flow

### New User Journey

1. **Visit Site** (with optional referral)
   ```
   User clicks: https://yoursite.com?ref=friend123
   → Referrer "friend123" stored in localStorage
   ```

2. **Enter Waitlist Code**
   ```
   User enters: 12345678
   → Code verified with backend
   → Code stored in localStorage
   → Redirect to /connect-twitter
   ```

3. **Connect Twitter**
   ```
   User clicks "CONNECT ACCOUNT"
   → Redirects to backend OAuth with code & referrer
   → Twitter authorization
   → User created in database
   → Unique invite code generated for user
   → Referrer awarded 1000 XP (if applicable)
   → Redirect to /earn-xp with JWT cookie
   ```

4. **Earn XP**
   ```
   Follow Twitter:
   → User follows @moleswap
   → Clicks "Verify"
   → Backend checks (currently trusts client)
   → Awards 500 XP (one-time)
   
   Share Link:
   → User clicks "Share Tweet"
   → Gets referral link: yoursite.com?ref=username
   → Shares on Twitter
   → New users sign up via link
   → User earns 1000 XP per referral (unlimited)
   
   Play Game:
   → User plays Whack-a-Mole
   → Hits 30+ moles (3000 in-game XP)
   → Backend receives: moleCount * 50 = XP
   → Awards up to 1500 XP max total
   → Tracks in user.gameXP
   ```

## XP System Rules

| Action | XP Amount | Limit | Notes |
|--------|-----------|-------|-------|
| Follow Twitter | 500 | One-time | Set `hasFollowed` flag |
| Referral Signup | 1000 | Unlimited | Per successful referral |
| Game (per mole) | 50 | 1500 total | Tracks in `gameXP` field |

## Authentication

- Uses JWT tokens stored in httpOnly cookies
- Cookie name: `token`
- Expiry: 7 days
- Auto-included in API requests via `credentials: 'include'`

## Error Handling

The API client handles errors gracefully:

```typescript
const response = await xpAPI.awardFollowXP();

if (response.error) {
  // Handle error
  console.error(response.error);
} else if (response.data) {
  // Handle success
  console.log(response.data);
}
```

## Testing Locally

1. Start backend: `cd mole-swap-backend && npm run dev`
2. Start frontend: `npm run dev`
3. Visit: http://localhost:3001
4. Follow user flow above

## Production Deployment

### Backend
- Deploy to service like Heroku, Railway, DigitalOcean
- Update environment variables
- Use MongoDB Atlas
- Enable HTTPS

### Frontend
- Update `NEXT_PUBLIC_API_URL` to production backend URL
- Update `NEXT_PUBLIC_APP_URL` to production frontend URL
- Deploy to Vercel, Netlify, etc.

### Twitter App
- Update callback URL to production backend URL
- Ensure OAuth 2.0 is configured correctly

## Security Notes

- All XP-earning endpoints require authentication
- Game XP validates: `moleCount * 50 === xpEarned`
- Follow XP is one-time per user
- Rate limiting on all endpoints
- CORS restricted to frontend URL
- httpOnly cookies prevent XSS

## Debugging

### Check User Authentication
```javascript
// In browser console
fetch('http://localhost:5000/api/auth/me', {
  credentials: 'include'
})
.then(r => r.json())
.then(console.log)
```

### Check XP Stats
```javascript
fetch('http://localhost:5000/api/xp/stats', {
  credentials: 'include'
})
.then(r => r.json())
.then(console.log)
```

### View Stored Data
```javascript
// In browser console
console.log('Referrer:', localStorage.getItem('referrer'));
console.log('Invite Code:', localStorage.getItem('inviteCode'));
console.log('Cookies:', document.cookie);
```

## Common Issues

### "Authentication required" error
- User not logged in
- Cookie expired
- CORS issue

**Solution**: Check if token cookie exists, re-authenticate if needed

### "Invite code not found"
- Code doesn't exist in database
- Code already used

**Solution**: Generate new invite codes, check database

### Referral not tracked
- Referrer not stored
- Session lost during OAuth

**Solution**: Ensure referrer stored before Twitter OAuth, pass in URL params

## Next Steps

- Add Twitter follow verification via API
- Add admin panel for invite code management
- Add analytics dashboard
- Add leaderboard page
- Add profile page with XP history
