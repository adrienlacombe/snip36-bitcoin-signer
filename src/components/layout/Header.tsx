interface HeaderProps {
  connected: boolean;
  starknetAddress: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function Header({ connected, starknetAddress, onConnect, onDisconnect }: HeaderProps) {
  return (
    <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-white">STRK20 Privacy Pool</h1>
        <span className="text-xs bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded">
          Starknet Sepolia
        </span>
      </div>
      {connected ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-green-400 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            Ledger
          </span>
          {starknetAddress && (
            <code className="text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">
              {starknetAddress.slice(0, 8)}...{starknetAddress.slice(-4)}
            </code>
          )}
          <button
            onClick={onDisconnect}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={onConnect}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Connect Ledger
        </button>
      )}
    </header>
  );
}
