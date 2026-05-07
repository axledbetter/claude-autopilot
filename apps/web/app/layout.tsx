import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'claude-autopilot',
  description: 'Local-first agentic dev workflows your security and finance teams can approve.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
