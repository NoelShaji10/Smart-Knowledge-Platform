import React from 'react';
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Newsreader } from 'next/font/google';
import { Providers } from './providers';
import '@/styles/globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  adjustFontFallback: false,
  variable: '--font-newsreader',
});

export const metadata: Metadata = {
  title: 'Knowledge Platform',
  description: 'AI-Powered Real-Time Collaboration & Knowledge Platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${newsreader.variable}`}
    >
      <body>
        <a href="#main-content" className="kp-skip-link">
          Skip to main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
