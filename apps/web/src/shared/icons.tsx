import type { ReactNode, SVGProps } from 'react';

// Occulta's own icon set: simple 24px line icons that follow the text color.

function Icon({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const ChannelsIcon = () => (
  <Icon>
    <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1z" />
    <path d="M9 9.5h6M9 12.5h4" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </Icon>
);

export const DepositIcon = () => (
  <Icon>
    <path d="M12 3v11M7.5 9.5 12 14l4.5-4.5" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </Icon>
);

export const WithdrawIcon = () => (
  <Icon>
    <path d="M12 14V3M7.5 7.5 12 3l4.5 4.5" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </Icon>
);

export const SendIcon = () => (
  <Icon>
    <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z" />
  </Icon>
);

export const ReceiveIcon = () => (
  <Icon>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M15 5 8 12l7 7" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const KeyIcon = () => (
  <Icon>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12 20 3M16.5 6.5 19 9M14 9l2 2" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Icon>
);

export const ArrowRightIcon = () => (
  <Icon>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const WalletIcon = () => (
  <Icon>
    <path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2" />
    <path d="M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z" />
    <circle cx="16" cy="14" r="1.2" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EditIcon = () => (
  <Icon>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="m13.5 6.5 4 4" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ThemeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
  </Icon>
);

/** The Occulta mark: a disc passing in front of another, an occultation. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="occulta-glow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a5b4fc" />
          <stop offset="1" stopColor="#c4b5fd" />
        </linearGradient>
      </defs>
      <circle cx="38" cy="28" r="20" fill="url(#occulta-glow)" />
      <circle cx="28" cy="36" r="20" className="logo-disc" />
      <circle cx="28" cy="36" r="20" fill="none" stroke="url(#occulta-glow)" strokeWidth="1.5" opacity="0.6" />
    </svg>
  );
}

/** A stable two-colour disc for a peer, so channels are easy to tell apart without names. */
export function Avatar({ seed, size = 44 }: { seed: string; size?: number }) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const a = hash % 360;
  const b = (a + 40 + ((hash >> 9) % 80)) % 360;
  return <span className="avatar" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${a} 70% 62%), hsl(${b} 70% 48%))` }} aria-hidden="true" />;
}
