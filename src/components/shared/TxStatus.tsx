import { STARKNET_SEPOLIA_EXPLORER } from '../../config/constants';

interface TxStatusProps {
  txHash: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export function TxStatus({ txHash, status }: TxStatusProps) {
  const truncated = txHash.slice(0, 10) + '...' + txHash.slice(-6);
  const explorerUrl = `${STARKNET_SEPOLIA_EXPLORER}/tx/${txHash}`;

  const statusColors = {
    pending: 'text-yellow-400',
    accepted: 'text-green-400',
    rejected: 'text-red-400',
  };

  return (
    <div className="flex items-center gap-3 bg-gray-800/50 rounded-lg px-3 py-2 text-sm">
      <span className={statusColors[status]}>
        {status === 'pending' && '...'}
        {status === 'accepted' && 'OK'}
        {status === 'rejected' && 'FAIL'}
      </span>
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-indigo-300 hover:text-indigo-200"
      >
        {truncated}
      </a>
    </div>
  );
}
