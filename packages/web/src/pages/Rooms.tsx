import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type RoomListPayload } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import { usePlatform } from '../state/PlatformContext';
import { Badge, Button, Empty, Panel, Skeleton, formatCoins } from '../components/ui';
import { audio } from '../game/Audio';

/**
 * Room lobby. Availability, seats and bet ranges all come from the API; a room
 * that cannot be entered says why instead of showing a dead button.
 */
export function Rooms(): JSX.Element {
  const navigate = useNavigate();
  const { wallet } = useAuth();
  const { config } = usePlatform();
  const [payload, setPayload] = useState<RoomListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (): void => {
    api
      .rooms()
      .then(setPayload)
      .catch((err) => setError(err instanceof Error ? err.message : 'Room list unavailable.'));
  };

  useEffect(load, []);

  const betOptions = useMemo(() => {
    const byRoom = new Map<string, { min: number; max: number; count: number }>();
    for (const cannon of config?.cannons ?? []) {
      for (const room of config?.rooms ?? []) {
        if (cannon.shotCost < room.minBet || cannon.shotCost > room.maxBet) continue;
        const entry = byRoom.get(room.key) ?? { min: room.minBet, max: room.maxBet, count: 0 };
        entry.count += 1;
        byRoom.set(room.key, entry);
      }
    }
    return byRoom;
  }, [config]);

  const enter = async (roomKey: string): Promise<void> => {
    setBusy(roomKey);
    try {
      await api.join(roomKey);
      void audio.unlock();
      navigate(`/play/${roomKey}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that room.');
    } finally {
      setBusy(null);
    }
  };

  const balance = wallet?.balance ?? 0;

  return (
    <div style={{ width: 'min(1240px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Choose a room</h1>
          <p className="sub">Every room is the same reef engine with a different bet range, fish density and seat count.</p>
        </div>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <Badge tone="gold">Balance {formatCoins(balance)} demo coins</Badge>
          {payload?.maintenance ? <Badge tone="red">Maintenance</Badge> : null}
        </div>
      </div>

      {error ? (
        <div className="notice-box danger small" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      ) : null}

      {payload === null && !error ? (
        <div className="room-grid">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={214} />
          ))}
        </div>
      ) : !payload?.rooms.length ? (
        <Panel>
          <Empty icon="🚪" title="No rooms are open" body="An operator has not published any active rooms yet, or the game is in maintenance." action={<Button size="sm" onClick={load}>Retry</Button>} />
        </Panel>
      ) : (
        <div className="room-grid">
          {payload.rooms.map((room, index) => {
            const occupied = room.playersInRoom >= room.maxPlayers;
            const tooPoor = balance < room.minBet;
            const fits = betOptions.get(room.key)?.count ?? 0;
            const blocked = occupied || tooPoor || payload.maintenance || fits === 0;
            const reason = payload.maintenance
              ? 'Rooms are closed for maintenance'
              : occupied
                ? 'Room is full — try another room'
                : tooPoor
                  ? `You need at least ${room.minBet} demo coins`
                  : fits === 0
                    ? 'No cannon you own fits this bet range'
                    : null;
            return (
              <article className="room-tile" key={room.id} data-locked={blocked}>
                <span className="water" aria-hidden="true" />
                <div className="row-between" style={{ gap: '0.5rem' }}>
                  <span className="depth-tag">Zone {index + 1}</span>
                  <span className="seat-dots" aria-label={`${room.playersInRoom} of ${room.maxPlayers} seats taken`}>
                    {Array.from({ length: room.maxPlayers }).map((_, seat) => (
                      <i key={seat} data-taken={seat < room.playersInRoom} />
                    ))}
                  </span>
                </div>
                <h3>{room.name}</h3>
                <p className="small muted" style={{ lineHeight: 1.5 }}>
                  {room.description}
                </p>
                <div className="row wrap" style={{ gap: '0.35rem' }}>
                  <span className="badge badge-gold num">
                    {room.minBet}–{room.maxBet} demo
                  </span>
                  <span className="badge num">{fits} cannons</span>
                  <span className="badge num">
                    {room.playersInRoom}/{room.maxPlayers} players
                  </span>
                </div>
                {room.currentRoundId ? <span className="tiny dim num">Round {room.currentRoundId}</span> : null}
                <div style={{ marginTop: 'auto', paddingTop: '0.7rem' }}>
                  {blocked ? (
                    <div className="col" style={{ gap: '0.4rem' }}>
                      <span className="tiny" style={{ color: 'var(--coral)', fontWeight: 700 }}>
                        {reason}
                      </span>
                      {tooPoor ? (
                        <Button size="sm" variant="ghost" onClick={() => navigate('/wallet')}>
                          Add demo coins
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <Button variant="primary" block loading={busy === room.key} onClick={() => void enter(room.key)}>
                      Enter room
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Panel title="How betting works" className="stack-1" >
        <p className="small muted" style={{ lineHeight: 1.6 }}>
          Your <strong>bet is the cost of every shot</strong>, taken from the cannon you select: a Tidecaster spends 1 demo coin per
          shot, a Reef Breaker spends 5. A room only accepts cannons whose per-shot cost falls inside its range, which is why the
          deeper rooms ask for bigger weapons. Rewards are fixed per species by the published configuration — defeating a Tide Grouper
          pays 20 demo coins whoever you are, what your balance is, or how the last round went.
        </p>
      </Panel>
    </div>
  );
}
