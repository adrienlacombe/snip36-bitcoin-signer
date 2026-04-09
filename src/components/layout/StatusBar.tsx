import { useState, useEffect } from 'react';
import { DISCOVERY_SERVICE_URL } from '../../config/constants';

interface HealthStatus {
  status: string;
  chain_head: {
    block_number: number;
    block_hash: string;
    timestamp: number;
  };
  lag_secs: number;
}

export function StatusBar() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    const fetchHealth = () => {
      fetch(`${DISCOVERY_SERVICE_URL}/health`)
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => setHealth(null));
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="border-b border-gray-800 px-6 py-1.5 flex items-center gap-4 text-xs text-gray-500">
      <span className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${health?.status === 'OK' ? 'bg-green-500' : 'bg-red-500'}`}
        />
        {health?.status === 'OK' ? 'Network Online' : 'Network Offline'}
      </span>
      {health && (
        <>
          <span>Block #{health.chain_head.block_number}</span>
          <span>Lag: {health.lag_secs}s</span>
        </>
      )}
    </div>
  );
}
