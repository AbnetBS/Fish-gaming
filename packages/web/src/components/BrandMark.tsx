import { Link } from 'react-router-dom';

export function BrandMark({ withLink = true }: { withLink?: boolean }): JSX.Element {
  const inner = (
    <>
      <span className="brand-mark" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M3 12c3.2-4.6 8.6-6.4 12.6-4.2 1.7.9 2.9 2.4 3.6 4.2-.7 1.8-1.9 3.3-3.6 4.2C11.6 18.4 6.2 16.6 3 12z" fill="url(#g)" />
          <path d="M19.2 12l2.6-2.4v4.8L19.2 12z" fill="#ffb703" />
          <circle cx="8.4" cy="11.2" r="1.15" fill="#04121f" />
          <defs>
            <linearGradient id="g" x1="3" y1="7" x2="19" y2="17" gradientUnits="userSpaceOnUse">
              <stop stopColor="#8fe9ff" />
              <stop offset="1" stopColor="#24d7ff" />
            </linearGradient>
          </defs>
        </svg>
      </span>
      <span className="brand-text hide-mobile">
        Reef<span className="brand-accent">Raiders</span>
      </span>
    </>
  );
  if (!withLink) return <span className="brand">{inner}</span>;
  return (
    <Link to="/" className="brand">
      {inner}
    </Link>
  );
}
