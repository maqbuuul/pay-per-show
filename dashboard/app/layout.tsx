import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pay Per Show',
  description: 'Billing reconciliation for a pay-per-show agency.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
