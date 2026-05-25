import { useEffect, useState } from 'react';
import { apiGet } from './lib/api';

type Health = { status: string };

export function App() {
  const [health, setHealth] = useState<string>('checking…');

  useEffect(() => {
    apiGet<Health>('/health')
      .then((h) => setHealth(h.status))
      .catch((e) => setHealth(`error: ${e.message}`));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32 }}>
      <h1>Fawtara</h1>
      <p>
        API health: <strong>{health}</strong>
      </p>
    </main>
  );
}
