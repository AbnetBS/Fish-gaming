import { Link } from 'react-router-dom';

export function NotFound(): JSX.Element {
  return (
    <div className="auth-wrap">
      <div className="auth-card card card-pad center stack-2">
        <div style={{ fontSize: '3rem' }}>🐡</div>
        <h1>Nothing in these waters</h1>
        <p className="muted small">That page drifted off the reef.</p>
        <div className="row" style={{ justifyContent: 'center', gap: '0.5rem' }}>
          <Link className="btn btn-primary" to="/">Back to the surface</Link>
          <Link className="btn btn-ghost" to="/dashboard">Dashboard</Link>
        </div>
      </div>
    </div>
  );
}
