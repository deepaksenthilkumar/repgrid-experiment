import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RepGrid Human Baseline Survey',
  description: 'Help establish a human baseline for ethical construct generation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        margin: 0,
        padding: 0,
        background: '#f5f5f5',
        color: '#333',
      }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px' }}>
          {children}
        </div>
      </body>
    </html>
  );
}
