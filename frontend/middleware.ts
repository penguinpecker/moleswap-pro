import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // All routes publicly accessible — no auth gating
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
