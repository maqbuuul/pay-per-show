import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { param } from '@/lib/format';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentUser()) redirect('/');
  const next = param(await searchParams, 'next') ?? '/';

  const demoEmail = process.env.DEMO_EMAIL;
  const demoPassword = process.env.DEMO_PASSWORD;
  const demo = demoEmail && demoPassword ? { email: demoEmail, password: demoPassword } : undefined;

  return (
    <main className="login">
      <div className="login-panel">
        <p className="wordmark">Pay Per Show</p>
        <h1>Sign in</h1>
        <p className="login-lede">
          Billing operations for clinics that pay per patient who attends.
        </p>
        <LoginForm next={next} demo={demo} />
        {demo && (
          <div className="demo-note">
            <p className="demo-note-title">Demo account</p>
            <dl>
              <div><dt>Email</dt><dd className="mono">{demo.email}</dd></div>
              <div><dt>Password</dt><dd className="mono">{demo.password}</dd></div>
            </dl>
            <p>
              The clinics and figures are synthetic. Everyone using the demo shares the same
              data, and it resets every night at 03:00 UTC.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
