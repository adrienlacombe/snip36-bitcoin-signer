import { CopyableHash } from '../shared/CopyableHash';
import { STARKNET_SEPOLIA_EXPLORER } from '../../config/constants';

interface FundingPanelProps {
  starknetAddress: string;
  balance: bigint;
  onRefresh: () => void;
  onContinue: () => void;
}

function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${fracStr}`;
}

export function FundingPanel({ starknetAddress, balance, onRefresh, onContinue }: FundingPanelProps) {
  const hasFunds = balance > 0n;

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-xl font-semibold text-white mb-4">Fund Your Account</h2>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <p className="text-gray-400 text-sm mb-4">
          Send STRK tokens to your Starknet account to start using the privacy pool.
        </p>

        <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
          <p className="text-xs text-gray-500 mb-1">Your Starknet Address</p>
          <CopyableHash hash={starknetAddress} />
          <a
            href={`${STARKNET_SEPOLIA_EXPLORER}/contract/${starknetAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 inline-block"
          >
            View on Voyager
          </a>
        </div>

        <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
          <p className="text-xs text-gray-500 mb-1">STRK Balance</p>
          <p className={`text-lg font-mono ${hasFunds ? 'text-green-400' : 'text-gray-400'}`}>
            {formatStrk(balance)} STRK
          </p>
          <button
            onClick={onRefresh}
            className="text-xs text-indigo-400 hover:text-indigo-300 mt-1"
          >
            Refresh
          </button>
        </div>

        {hasFunds ? (
          <button
            onClick={onContinue}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
          >
            Continue to Privacy Pool
          </button>
        ) : (
          <p className="text-gray-500 text-sm text-center">
            Waiting for funds... Send STRK from a faucet or another account.
          </p>
        )}
      </div>
    </div>
  );
}
