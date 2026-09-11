import { Link } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import { usePlatform } from '../state/PlatformContext';
import { Panel } from '../components/ui';

/**
 * Responsible gaming. The demo section states what this build is; the second
 * section documents what a licensed real-money deployment must provide, because
 * those controls must exist before money is ever involved — not after.
 */
export function ResponsibleGaming(): JSX.Element {
  const { isAuthed } = useAuth();
  const { meta } = usePlatform();

  return (
    <div className="landing">
      <div className="app-shell">
        <main className="app-main" style={{ paddingTop: '2.2rem' }}>
          <div className="container-tight stack-3" style={{ width: 'min(880px, 100% - 2rem)', marginInline: 'auto' }}>
            <div>
              <span className="kicker" style={{ color: 'var(--cyan)', fontWeight: 800, letterSpacing: '0.22em', textTransform: 'uppercase', fontSize: '0.7rem' }}>
                Responsible gaming
              </span>
              <h1 style={{ fontSize: 'clamp(1.8rem,4.5vw,2.8rem)', marginTop: '0.5rem' }}>Play for fun, not for money</h1>
            </div>

            <div className="notice-box">
              <h3 style={{ fontSize: '1.1rem' }}>This version uses virtual DEMO COINS only.</h3>
              <ul className="col" style={{ marginTop: '0.7rem', gap: '0.4rem', paddingLeft: '1.1rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                <li>Demo coins have no cash value and are not money.</li>
                <li>They cannot be purchased, exchanged, withdrawn or transferred between accounts.</li>
                <li>There are no prizes, jackpots or payouts of any kind.</li>
                <li>Nothing on this site is an offer to gamble, and no outcome here has financial consequence.</li>
                <li>Rewards are fixed by a published game configuration and are identical for every player.</li>
              </ul>
            </div>

            <Panel title="Play habits that keep this enjoyable">
              <div className="features" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                {[
                  { icon: '⏱', title: 'Set a play limit', body: 'Choose a daily minute budget in Settings. When it runs out the server stops accepting your shots — it is not a reminder you can ignore.' },
                  { icon: '💤', title: 'Take breaks', body: 'Arcade games reward fast reflexes and punish fatigue. Step away when you feel either.' },
                  { icon: '🎯', title: 'Play for skill', body: 'Aim and fish variety are the challenge. There is nothing to win beyond the score.' },
                  { icon: '🌙', title: 'Take a real break', body: 'Start a 24-hour, 7, 30 or 90-day self-exclusion. It closes your round immediately and only an admin can lift it early.' },
                  { icon: '🔞', title: 'Adults only', body: 'This product is intended for players 18 and over.' },
                ].map((item) => (
                  <article className="feature" key={item.title}>
                    <span className="ico">{item.icon}</span>
                    <div>
                      <h4>{item.title}</h4>
                      <p>{item.body}</p>
                    </div>
                  </article>
                ))}
              </div>
            </Panel>

            <Panel title="What this build already enforces">
              <div className="editor-grid" style={{ marginTop: '0.4rem' }}>
                {[
                  ['Daily play limit', 'Minutes are summed from your real play sessions. Past the limit, shots are refused server-side and the round is closed.'],
                  ['Self-exclusion', 'Player-initiated, effective immediately, and impossible to shorten from your own account.'],
                  ['Play-time HUD', 'The game screen shows minutes used against your budget while you play, so there is no guessing.'],
                  ['No dark patterns', 'No loss recovery, no "one more round" nudges, no purchase pressure — demo coins cannot be bought.'],
                  ['Auditable outcomes', 'Every shot, reward and configuration version is written to a ledger an admin cannot edit.'],
                ].map(([title, body]) => (
                  <div key={title} className="stat-tile">
                    <div className="k">{title}</div>
                    <p className="tiny" style={{ marginTop: 4, color: 'var(--muted)', lineHeight: 1.5 }}>{body}</p>
                  </div>
                ))}
              </div>
              <p className="tiny dim" style={{ marginTop: '0.8rem' }}>
                These exist because they are good practice, not because virtual coins carry statutory obligations. A real-money
                deployment must meet everything in the next section — the flags below are not enabled by flipping a switch.
              </p>
            </Panel>

            <Panel title="If real-money play is ever authorised">
              <p className="small muted" style={{ lineHeight: 1.65 }}>
                Real-money mode is switched off at the deployment level and stays off. {meta?.legal.realMoneyNotice ?? ''} A future
                real-money version would only ship with all of the following enforced by the server, verified by the operator's
                regulators and auditors, and impossible to disable from the game client:
              </p>
              <div className="editor-grid" style={{ marginTop: '0.9rem' }}>
                {[
                  ['Licensing', 'A valid online gaming or lottery licence for each jurisdiction operated in.'],
                  ['Age assurance', 'Verified 18+/21+ checks appropriate to the jurisdiction before any deposit.'],
                  ['KYC / identity', 'Documented identity verification before funding or payout.'],
                  ['AML / CTF', 'Sanctions and PEP screening, source-of-funds checks, ongoing transaction monitoring and reporting.'],
                  ['Geographic controls', 'Location verification with blocking where online real-money play is not permitted.'],
                  ['Payment rules', 'Only licensed, approved payment providers, with webhook-verified settlement.'],
                  ['Player limits', 'Deposit, loss, wager and time limits, with cooling-off periods.'],
                  ['Self-exclusion', 'Permanent and temporary self-exclusion honoured across the operator estate.'],
                  ['Reality checks', 'Session duration and net-position reminders during play.'],
                  ['Game fairness', 'Certified RNG, published RTP, versioned configurations and independent audit.'],
                  ['Advertising rules', 'No claims of guaranteed or easy winnings; age-gated marketing only.'],
                  ['Support & signposting', 'Route to problem-gambling help, with trained staff and escalation.'],
                ].map(([title, body]) => (
                  <div key={title} className="stat-tile">
                    <div className="k">{title}</div>
                    <p className="tiny" style={{ marginTop: 4, color: 'var(--muted)', lineHeight: 1.5 }}>{body}</p>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Getting help">
              <p className="small muted" style={{ lineHeight: 1.6 }}>
                If gambling stops being enjoyable for you or someone you know, stop and talk to someone. In many countries a
                problem-gambling helpline is free and confidential — search for your national gambling help line, or contact your
                local health service. Support is also available for concerns about underage play.
              </p>
              <div className="row wrap" style={{ marginTop: '0.9rem', gap: '0.5rem' }}>
                {isAuthed ? (
                  <Link className="btn btn-ghost" to="/settings">Play limits &amp; self-exclusion in settings</Link>
                ) : (
                  <Link className="btn btn-ghost" to="/login">Log in to set a play limit</Link>
                )}
                <Link className="btn btn-primary" to="/play">Back to the game</Link>
              </div>
            </Panel>
          </div>
        </main>
      </div>
    </div>
  );
}
