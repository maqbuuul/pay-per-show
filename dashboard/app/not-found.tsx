import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="login">
      <div className="login-panel">
        <p className="wordmark">Pay Per Show</p>
        <h1>Not found</h1>
        <p className="login-lede">That page does not exist, or the record has been removed.</p>
        <Link href="/" className="btn btn-secondary">Go to Today</Link>
      </div>
    </main>
  );
}
