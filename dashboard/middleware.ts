import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = 'pps_session';
const SESSION_DAYS = 7;

// A fast redirect for visitors without a session cookie. Pages and actions
// still check the session against the database; this is not the security check.
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(COOKIE)?.value;
  const isPublic = pathname === '/login' || pathname.startsWith('/api/cron/');

  if (!token && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  // Keep the cookie's lifetime in step with the sliding session. Skipped on
  // POST so it cannot race a sign-out that deletes the cookie.
  if (token && req.method === 'GET') {
    res.cookies.set(COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
