import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'HS Code Classifier API',
  description: 'AI-powered customs code classifier API',
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
