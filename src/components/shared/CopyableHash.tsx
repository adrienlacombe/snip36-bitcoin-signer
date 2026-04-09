import { useState } from 'react';

export function CopyableHash({ hash, label }: { hash: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const truncated = hash.slice(0, 8) + '...' + hash.slice(-6);

  const copy = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="text-gray-400 text-sm">{label}</span>}
      <code className="bg-gray-800 px-2 py-0.5 rounded text-sm font-mono text-indigo-300">
        {truncated}
      </code>
      <button
        onClick={copy}
        className="text-gray-500 hover:text-indigo-400 text-xs transition-colors"
        title="Copy to clipboard"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
