import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ALB Load-Balancer Tester',
  description:
    'Test Datum HTTPProxy weighted backends and load-balancing algorithms',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
