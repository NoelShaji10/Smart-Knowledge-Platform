import React from 'react';

export const metadata = {
  title: 'AI Knowledge Platform',
  description: 'AI-Powered Real-Time Collaboration & Knowledge Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
