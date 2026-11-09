import React, { ReactNode } from 'react';
import styles from './layout.module.css';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" className={styles.authWrapper}>
      {/* Left Marketing & Collaborative Mesh Canvas (~48% width on desktop) */}
      <section className={styles.leftSection} aria-label="Knowledge Platform Overview">
        {/* Background Ambient Glow & Mesh Grid */}
        <div className={styles.ambientGlowTop} aria-hidden="true" />
        <div className={styles.ambientGlowBottom} aria-hidden="true" />
        <div className={styles.gridOverlay} aria-hidden="true">
          <svg className={styles.gridSvg} xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="auth-grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255, 255, 255, 0.08)" strokeWidth="1" />
                <circle cx="0" cy="0" r="1.5" fill="rgba(96, 165, 250, 0.35)" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#auth-grid-pattern)" />
          </svg>
        </div>

        {/* Top Branding Header */}
        <div className={styles.brandHeader}>
          <div className={styles.logoBadge} aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <path d="M9 7h6" />
              <path d="M9 11h6" />
            </svg>
          </div>
          <div className={styles.brandText}>
            <span className={styles.wordmark}>Knowledge Platform</span>
            <span className={styles.wordmarkKicker}>Collaborative Mesh</span>
          </div>
        </div>

        {/* Central Visual Narrative & Live Knowledge Stack */}
        <div className={styles.narrativeContainer}>
          <div className={styles.headlineBlock}>
            <h1 className={styles.editorialHeading}>Your team&apos;s knowledge, connected.</h1>
            <p className={styles.narrativeDescription}>
              A collaborative workspace to create, organize, and share knowledge with your team.
            </p>
          </div>

          {/* Connected Glassmorphic Preview Canvas */}
          <div className={styles.glassCanvas} aria-hidden="true">
            {/* SVG Connecting Mesh Paths */}
            <svg className={styles.meshPathSvg} xmlns="http://www.w3.org/2000/svg">
              <path
                d="M 60 70 C 130 90, 160 140, 240 160"
                fill="none"
                stroke="rgba(96, 165, 250, 0.35)"
                strokeDasharray="4 4"
                strokeWidth="2"
              />
              <path
                d="M 280 180 C 310 210, 260 250, 190 270"
                fill="none"
                stroke="rgba(96, 165, 250, 0.35)"
                strokeDasharray="4 4"
                strokeWidth="2"
              />
              <circle cx="240" cy="160" r="3.5" fill="#60a5fa" />
              <circle cx="190" cy="270" r="3.5" fill="#93c5fd" />
            </svg>

            {/* Interconnected Knowledge Cards */}
            <div className={styles.cardsStack}>
              {/* Card 1: Architecture RFC */}
              <div className={styles.glassCard}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleGroup}>
                    <div className={`${styles.cardIconBox} ${styles.blueIconBox}`}>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="3" y="3" width="7" height="7" />
                        <rect x="14" y="3" width="7" height="7" />
                        <rect x="14" y="14" width="7" height="7" />
                        <path d="M10 7h4" />
                        <path d="M7 10v7a2 2 0 0 0 2 2h5" />
                      </svg>
                    </div>
                    <div>
                      <div className={styles.cardTitle}>Engineering Architecture RFC</div>
                      <div className={styles.cardMeta}>Distributed consensus &amp; edge replicas</div>
                    </div>
                  </div>
                  <span className={styles.bluePill}>v9 current</span>
                </div>
                <div className={styles.cardFooter}>
                  <div className={styles.collaboratorsLive}>
                    <span className={styles.pulseDot} />
                    <span className={styles.liveText}>3 collaborators active</span>
                  </div>
                  <span className={styles.timeText}>Updated 4m ago</span>
                </div>
              </div>

              {/* Card 2: Product Specifications */}
              <div className={`${styles.glassCard} ${styles.offsetCard}`}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleGroup}>
                    <div className={`${styles.cardIconBox} ${styles.indigoIconBox}`}>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                      </svg>
                    </div>
                    <div>
                      <div className={styles.cardTitle}>Product Specifications &amp; Guidelines</div>
                      <div className={styles.cardMeta}>Design tokens, telemetry &amp; flows</div>
                    </div>
                  </div>
                  <span className={styles.indigoPill}>Live sync</span>
                </div>
                <div className={styles.cardFooter}>
                  <div className={styles.avatarStack}>
                    <div className={`${styles.miniAvatar} ${styles.avatar1}`}>AC</div>
                    <div className={`${styles.miniAvatar} ${styles.avatar2}`}>MR</div>
                    <div className={`${styles.miniAvatar} ${styles.avatar3}`}>SL</div>
                  </div>
                  <span className={styles.verifiedText}>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    Verified document
                  </span>
                </div>
              </div>

              {/* Card 3: Team Onboarding */}
              <div className={styles.glassCard}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleGroup}>
                    <div className={`${styles.cardIconBox} ${styles.cyanIconBox}`}>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m9 11 3 3L22 4" />
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                      </svg>
                    </div>
                    <div>
                      <div className={styles.cardTitle}>Team Onboarding &amp; Runbooks</div>
                      <div className={styles.cardMeta}>Fast path setup guides &amp; escalation</div>
                    </div>
                  </div>
                  <span className={styles.shortcutPill}>⌘K to jump</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Platform Footer */}
        <div className={styles.bottomFooter}>
          <span>Engineered for high-performing modern engineering and product teams.</span>
          <div className={styles.statusIndicator}>
            <span className={styles.liveIndicatorDot} />
            <span>Built for real-time collaboration</span>
          </div>
        </div>
      </section>

      {/* Right Form Card Section (~52% width on desktop) */}
      <section className={styles.rightSection}>
        <div className={styles.cardContainer}>
          {/* Mobile Platform Brand Header (Visible on smaller viewports) */}
          <div className={styles.mobileBrandHeader}>
            <div className={styles.mobileLogoBadge} aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                <path d="M9 7h6" />
                <path d="M9 11h6" />
              </svg>
            </div>
            <span className={styles.mobileWordmark}>Knowledge Platform</span>
          </div>

          {/* Form Card Content */}
          <div className={styles.authCard}>{children}</div>

          {/* Footnote Link */}
          <div className={styles.footnote}>
            <span>Need assistance? </span>
            <span className={styles.footnoteHighlight}>Contact workspace admin</span>
          </div>
        </div>
      </section>
    </main>
  );
}
