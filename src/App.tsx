import { useState, useEffect, useCallback } from 'react';
import { Header } from './components/layout/Header';
import { StatusBar } from './components/layout/StatusBar';
import { FundingPanel } from './components/fund/FundingPanel';
import { CopyableHash } from './components/shared/CopyableHash';
import { PrivacyActions } from './components/PrivacyActions';
import { useLedger } from './hooks/useLedger';
import { STARKNET_SEPOLIA_EXPLORER, STRK_TOKEN_ADDRESS } from './config/constants';

function formatStrk(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac}`;
}

interface PrivateNote {
  token: string;
  amount: bigint;
}

function App() {
  const ledger = useLedger();
  const [privateNotes, setPrivateNotes] = useState<PrivateNote[]>([]);
  const [privateBalanceLoading, setPrivateBalanceLoading] = useState(false);

  const refreshPrivateBalance = useCallback(async () => {
    if (!ledger.transfers || !ledger.viewingKeySet) return;
    setPrivateBalanceLoading(true);
    try {
      const { notes } = await ledger.transfers.discoverNotes({ tokens: [BigInt(STRK_TOKEN_ADDRESS)] });
      const strkNotes = notes.get(BigInt(STRK_TOKEN_ADDRESS)) || [];
      setPrivateNotes(strkNotes.map((n: any) => ({ token: STRK_TOKEN_ADDRESS, amount: BigInt(n.amount) })));
    } catch (e) {
      console.error('Failed to discover notes:', e);
    } finally {
      setPrivateBalanceLoading(false);
    }
  }, [ledger.transfers, ledger.viewingKeySet]);

  useEffect(() => { refreshPrivateBalance(); }, [refreshPrivateBalance]);

  // Determine phase
  let phase: 'connect' | 'deploy' | 'fund' | 'interact' = 'connect';
  if (ledger.connected) {
    if (!ledger.deployed) phase = 'deploy';
    else if (ledger.balance === 0n) phase = 'fund';
    else phase = 'interact';
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0f]">
      <Header
        connected={ledger.connected}
        starknetAddress={ledger.starknetAddress}
        onConnect={() => ledger.connect()}
        onDisconnect={() => ledger.disconnect()}
      />
      <StatusBar />

      <main className="flex-1 px-6 py-8">
        {/* Loading overlay */}
        {ledger.loading && (
          <div className="max-w-lg mx-auto mb-6 bg-indigo-900/30 border border-indigo-800 rounded-lg p-4 text-center">
            <p className="text-indigo-300 text-sm">{ledger.loading}</p>
          </div>
        )}

        {/* Error */}
        {ledger.error && (
          <div className="max-w-lg mx-auto mb-6 bg-red-900/30 border border-red-800 rounded-lg p-3 text-red-300 text-sm">
            {ledger.error}
          </div>
        )}

        {/* Connect */}
        {phase === 'connect' && (
          <div className="max-w-lg mx-auto text-center py-16">
            <h2 className="text-2xl font-semibold text-white mb-3">STRK20 Privacy Pool</h2>
            <p className="text-gray-400 mb-6">
              Connect your Ledger with the Bitcoin app to deploy a Starknet account
              and interact with the STRK20 privacy pool.
            </p>
            <button
              onClick={() => ledger.connect()}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
            >
              Connect Ledger Bitcoin
            </button>
            <p className="text-gray-600 text-xs mt-4">
              Make sure the Bitcoin app is open on your Ledger
            </p>
          </div>
        )}

        {/* Deploy */}
        {phase === 'deploy' && ledger.starknetAddress && (
          <div className="max-w-lg mx-auto">
            <h2 className="text-xl font-semibold text-white mb-4">Deploy Account</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <p className="text-gray-400 text-sm mb-4">
                Your Starknet address (derived from your Ledger Bitcoin key):
              </p>
              <CopyableHash hash={ledger.starknetAddress} />
              <button
                onClick={ledger.deploy}
                disabled={!!ledger.loading}
                className="w-full mt-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
              >
                Deploy (Gasless via AVNU)
              </button>
            </div>
          </div>
        )}

        {/* Fund */}
        {phase === 'fund' && ledger.starknetAddress && (
          <FundingPanel
            starknetAddress={ledger.starknetAddress}
            balance={ledger.balance}
            onRefresh={ledger.refreshBalance}
            onContinue={ledger.refreshBalance}
          />
        )}

        {/* Interact */}
        {phase === 'interact' && ledger.starknetAddress && ledger.account && ledger.signer && ledger.transfers && (
          <div className="max-w-2xl mx-auto">
            <h2 className="text-xl font-semibold text-white mb-4">Privacy Pool</h2>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-4">
              <div className="mb-4">
                <div className="flex justify-between items-center mb-3">
                  <div>
                    <p className="text-gray-400 text-xs">Account</p>
                    <CopyableHash hash={ledger.starknetAddress} />
                  </div>
                  <button onClick={() => { ledger.refreshBalance(); refreshPrivateBalance(); }}
                    className="text-xs text-indigo-400 hover:text-indigo-300">refresh</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <p className="text-gray-500 text-xs mb-1">Public Balance</p>
                    <p className="text-white font-mono text-sm">{formatStrk(ledger.balance)} STRK</p>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <p className="text-gray-500 text-xs mb-1">Private Balance {privateBalanceLoading && '...'}</p>
                    <p className="text-indigo-300 font-mono text-sm">
                      {privateNotes.length > 0
                        ? formatStrk(privateNotes.reduce((sum, n) => sum + n.amount, 0n)) + ' STRK'
                        : '0.0000 STRK'}
                    </p>
                    {privateNotes.length > 0 && (
                      <p className="text-gray-600 text-xs mt-0.5">{privateNotes.length} note{privateNotes.length > 1 ? 's' : ''}</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <span className={`text-xs px-2 py-1 rounded ${ledger.viewingKeySet ? 'bg-green-900/50 text-green-400' : 'bg-yellow-900/50 text-yellow-400'}`}>
                  Viewing Key: {ledger.viewingKeySet ? 'Set' : 'Not Set'}
                </span>
                <a href={`${STARKNET_SEPOLIA_EXPLORER}/contract/${ledger.starknetAddress}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1">Explorer</a>
              </div>
            </div>

            <PrivacyActions
              address={ledger.starknetAddress}
              signer={ledger.signer}
              account={ledger.account}
              transfers={ledger.transfers}
              viewingKeySet={ledger.viewingKeySet}
              onViewingKeySet={() => ledger.connect()}
              onBalanceChange={() => { ledger.refreshBalance(); refreshPrivateBalance(); }}
            />
          </div>
        )}
      </main>

      <footer className="border-t border-gray-800 px-6 py-3 text-center text-xs text-gray-600">
        STRK20 Privacy Pool — Starknet Sepolia — Ledger Bitcoin
      </footer>
    </div>
  );
}

export default App;
