import { useState } from 'react';
import { RpcProvider, hash, transaction, type Account } from 'starknet';
import type { PrivateTransfersInterface } from '@starkware-libs/starknet-privacy-sdk';
import type { LedgerBitcoinSigner } from '../lib/signer';
import { STARKNET_RPC_URL, STRK_TOKEN_ADDRESS, PRIVACY_POOL_ADDRESS, STARKNET_SEPOLIA_EXPLORER } from '../config/constants';

const toHex = (v: string) => v.startsWith('0x') ? v : '0x' + BigInt(v).toString(16);

const RB = {
  l1_gas: { max_amount: 0x200n, max_price_per_unit: 0x800000000000n },
  l2_gas: { max_amount: 0x20000000n, max_price_per_unit: 0x1000000000n },
  l1_data_gas: { max_amount: 0x800n, max_price_per_unit: 0x800000000000n },
};

const RB_STR = {
  l1_gas: { max_amount: '0x200', max_price_per_unit: '0x800000000000' },
  l2_gas: { max_amount: '0x20000000', max_price_per_unit: '0x1000000000' },
  l1_data_gas: { max_amount: '0x800', max_price_per_unit: '0x800000000000' },
};

interface TxRecord {
  hash: string;
  action: string;
  status: 'pending' | 'success' | 'reverted';
}

async function submitWithProof(
  provider: RpcProvider, signer: LedgerBitcoinSigner, address: string,
  call: any,
  proof: { data: string; proofFacts: string[] },
): Promise<string> {
  const chainId = await provider.getChainId();
  const nonce = await provider.getNonceForAddress(address);
  const calldata = transaction.getExecuteCalldata([call], '1').map(toHex);
  const txHash = hash.calculateInvokeTransactionHash({
    senderAddress: address, version: '0x3', compiledCalldata: calldata, chainId,
    nonce: toHex(nonce), accountDeploymentData: [], nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0, paymasterData: [], resourceBounds: RB, tip: 0n,
    proofFacts: proof.proofFacts.map(f => BigInt(f)),
  } as any);
  const sig = await signer.signHash(txHash);
  const sigArr: string[] = (Array.isArray(sig) ? sig : [sig]).map(String);
  const res = await fetch(STARKNET_RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'starknet_addInvokeTransaction', params: {
      invoke_transaction: { type: 'INVOKE', version: '0x3', sender_address: address,
        calldata, signature: sigArr.map(toHex), nonce: toHex(nonce),
        resource_bounds: RB_STR,
        tip: '0x0', paymaster_data: [], account_deployment_data: [],
        nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
        proof_facts: proof.proofFacts, proof: proof.data,
      }}, id: 1 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(String(data.error.data || data.error.message).slice(0, 200));
  return data.result.transaction_hash;
}

interface Props {
  address: string;
  signer: LedgerBitcoinSigner;
  account: Account;
  transfers: PrivateTransfersInterface;
  viewingKeySet: boolean;
  onViewingKeySet: () => void;
  onBalanceChange: () => void;
}

export function PrivacyActions({ address, signer, account, transfers, viewingKeySet, onViewingKeySet, onBalanceChange }: Props) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [depositAmount, setDepositAmount] = useState('0.01');
  const [withdrawAmount, setWithdrawAmount] = useState('0.005');
  const [withdrawTo, setWithdrawTo] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('0.005');

  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC_URL });

  const addTx = (hash: string, action: string) => setTxs(prev => [{ hash, action, status: 'pending' }, ...prev]);
  const updateTx = (hash: string, status: 'success' | 'reverted') => setTxs(prev => prev.map(t => t.hash === hash ? { ...t, status } : t));

  // SetViewingKey
  const handleSetViewingKey = async () => {
    setError('');
    try {
      setStatus('Step 1/3: Building ZK proof — sign on Ledger...');
      const latestBlock = await provider.getBlockNumber();
      const result = await transfers.build({ autoRegister: true, provingBlockId: latestBlock - 10 }).execute();
      setStatus('Step 2/3: Submitting on-chain — sign on Ledger...');
      const txHash = await submitWithProof(provider, signer, address, result.callAndProof.call, result.callAndProof.proof);
      addTx(txHash, 'SetViewingKey');
      setStatus('Step 3/3: Waiting for on-chain confirmation...');
      const receipt = await provider.waitForTransaction(txHash);
      if (receipt.isSuccess()) { updateTx(txHash, 'success'); onViewingKeySet(); setStatus(''); }
      else {
        updateTx(txHash, 'reverted');
        const reason = (receipt.value as any).revert_reason || '';
        // Decode felt error messages
        const felts = reason.match(/0x[0-9a-fA-F]{10,40}/g) || [];
        const decoded = felts.map((f: string) => {
          const h = f.slice(2);
          const b = new Uint8Array(h.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substring(i*2, i*2+2), 16);
          return String.fromCharCode(...b).replace(/[^\x20-\x7E]/g, '');
        }).filter((s: string) => s.length > 4);
        setError('SetViewingKey reverted: ' + (decoded.join(' | ') || reason.slice(0, 300)));
        setStatus('');
      }
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes('not deployed')) setError('Account not found at proving block. Wait ~70 min after deployment before using privacy features.');
      else if (msg.includes('Reverted')) setError('Proving failed. State changes need ~70 min (420 blocks) to be visible to the prover. If you just set the viewing key or made a deposit, wait and try again.');
      else setError(msg.slice(0, 300));
      setStatus('');
    }
  };

  // Deposit
  const handleDeposit = async () => {
    setError(''); const amount = BigInt(Math.floor(parseFloat(depositAmount) * 1e18));
    if (amount <= 0n) { setError('Invalid amount'); return; }

    try {
      // Step 1: Approve
      setStatus('Step 1/4: Approving STRK — sign on Ledger...');
      const approveTx = await account.execute(
        [{ contractAddress: STRK_TOKEN_ADDRESS, entrypoint: 'approve', calldata: [PRIVACY_POOL_ADDRESS, amount.toString(), '0'] }],
        { tip: 0n, resourceBounds: RB },
      );
      setStatus('Step 1/4: Waiting for approve confirmation...');
      await provider.waitForTransaction(approveTx.transaction_hash);

      // Step 2: Build proof via SDK
      setStatus('Step 2/4: Building ZK proof — sign on Ledger...');
      const latestBlock = await provider.getBlockNumber();
      const result = await transfers.build({ autoSetup: true, provingBlockId: latestBlock - 10 })
        .with(STRK_TOKEN_ADDRESS, (t: any) => t.deposit({ amount }))
        .surplusTo(address)
        .execute();

      // Step 3: Submit on-chain
      setStatus('Step 3/4: Submitting on-chain — sign on Ledger...');
      const txHash = await submitWithProof(provider, signer, address, result.callAndProof.call, result.callAndProof.proof);
      addTx(txHash, `Deposit ${depositAmount} STRK`);

      // Step 4: Wait for confirmation
      setStatus('Step 4/4: Waiting for on-chain confirmation...');
      const receipt = await provider.waitForTransaction(txHash);
      if (receipt.isSuccess()) { updateTx(txHash, 'success'); onBalanceChange(); setStatus(''); }
      else { updateTx(txHash, 'reverted'); setError('Deposit reverted'); setStatus(''); }
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes('Reverted')) setError('Proving failed. If you just set the viewing key or deposited, wait ~2 min and try again.');
      else setError(msg.slice(0, 300));
      setStatus('');
    }
  };

  // Withdraw
  const handleWithdraw = async () => {
    setError(''); const amount = BigInt(Math.floor(parseFloat(withdrawAmount) * 1e18));
    const recipient = withdrawTo || address;
    if (amount <= 0n) { setError('Invalid amount'); return; }

    try {
      // Step 1: Build proof
      setStatus('Step 1/3: Discovering notes and building ZK proof — sign on Ledger...');
      const latestBlock = await provider.getBlockNumber();

      // Discover notes first to check balance
      const { notes } = await transfers.discoverNotes({ tokens: [BigInt(STRK_TOKEN_ADDRESS)] });
      const strkNotes = notes.get(BigInt(STRK_TOKEN_ADDRESS)) || [];
      const totalPrivate = strkNotes.reduce((s: bigint, n: any) => s + BigInt(n.amount), 0n);
      console.log('[withdraw] notes:', strkNotes.length, 'total:', totalPrivate.toString());
      if (totalPrivate < amount) {
        setError(`Insufficient private balance: ${(totalPrivate / 10n**18n).toString()} STRK available, ${(amount / 10n**18n).toString()} requested`);
        setStatus('');
        return;
      }

      setStatus('Step 1/3: Building ZK proof — sign on Ledger...');
      const result = await transfers.build({
        autoSelectNotes: 'all',
        autoSetup: true,
        autoDiscover: { channels: 'missing' },
        provingBlockId: latestBlock - 10,
      })
        .with(STRK_TOKEN_ADDRESS, (t: any) => t
          .inputs(...strkNotes)
          .withdraw({ recipient, amount }))
        .surplusTo(address, true) // true = withdraw surplus too (no change note needed)
        .execute();

      // Step 2: Submit on-chain
      setStatus('Step 2/3: Submitting on-chain — sign on Ledger...');
      const txHash = await submitWithProof(provider, signer, address, result.callAndProof.call, result.callAndProof.proof);
      addTx(txHash, `Withdraw ${withdrawAmount} STRK`);

      // Step 3: Wait for confirmation
      setStatus('Step 3/3: Waiting for on-chain confirmation...');
      const receipt = await provider.waitForTransaction(txHash);
      if (receipt.isSuccess()) { updateTx(txHash, 'success'); onBalanceChange(); setStatus(''); }
      else { updateTx(txHash, 'reverted'); setError('Withdraw reverted'); setStatus(''); }
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes('Reverted')) {
        // Try to decode felt errors
        const felts = msg.match(/0x[0-9a-fA-F]{10,40}/g) || [];
        const decoded = felts.map((f: string) => {
          const h = f.slice(2);
          const b = new Uint8Array(h.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substring(i*2, i*2+2), 16);
          return String.fromCharCode(...b).replace(/[^\x20-\x7E]/g, '');
        }).filter((s: string) => s.length > 4);
        setError('Proving failed: ' + (decoded.join(' | ') || 'If you just deposited, wait ~2 min then try again.'));
      } else setError(msg.slice(0, 300));
      setStatus('');
    }
  };

  // Private Transfer
  const handleTransfer = async () => {
    setError('');
    const amount = BigInt(Math.floor(parseFloat(transferAmount) * 1e18));
    if (amount <= 0n) { setError('Invalid amount'); return; }
    if (!transferTo) { setError('Recipient address required'); return; }

    try {
      setStatus('Step 1/3: Discovering notes and building ZK proof — sign on Ledger...');
      const latestBlock = await provider.getBlockNumber();

      const { notes } = await transfers.discoverNotes({ tokens: [BigInt(STRK_TOKEN_ADDRESS)] });
      const strkNotes = notes.get(BigInt(STRK_TOKEN_ADDRESS)) || [];
      const totalPrivate = strkNotes.reduce((s: bigint, n: any) => s + BigInt(n.amount), 0n);
      if (totalPrivate < amount) {
        setError(`Insufficient private balance: ${(totalPrivate / 10n**18n).toString()} STRK`);
        setStatus('');
        return;
      }

      setStatus('Step 1/3: Building ZK proof — sign on Ledger...');
      const result = await transfers.build({
        autoSelectNotes: 'all',
        autoSetup: true,
        autoDiscover: { channels: 'missing' },
        provingBlockId: latestBlock - 10,
      })
        .with(STRK_TOKEN_ADDRESS, (t: any) => t
          .inputs(...strkNotes)
          .transfer({ recipient: transferTo, amount }))
        .surplusTo(address)
        .execute();

      setStatus('Step 2/3: Submitting on-chain — sign on Ledger...');
      const txHash = await submitWithProof(provider, signer, address, result.callAndProof.call, result.callAndProof.proof);
      addTx(txHash, `Transfer ${transferAmount} STRK → ${transferTo.slice(0, 8)}...`);

      setStatus('Step 3/3: Waiting for on-chain confirmation...');
      const receipt = await provider.waitForTransaction(txHash);
      if (receipt.isSuccess()) { updateTx(txHash, 'success'); onBalanceChange(); setStatus(''); }
      else { updateTx(txHash, 'reverted'); setError('Transfer reverted'); setStatus(''); }
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes('Channel not found')) setError('No channel to recipient. The first transfer to a new address requires channel setup (autoSetup should handle this).');
      else if (msg.includes('Reverted')) {
        const felts = msg.match(/0x[0-9a-fA-F]{10,40}/g) || [];
        const decoded = felts.map((f: string) => {
          const h = f.slice(2);
          const b = new Uint8Array(h.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substring(i*2, i*2+2), 16);
          return String.fromCharCode(...b).replace(/[^\x20-\x7E]/g, '');
        }).filter((s: string) => s.length > 4);
        setError('Proving failed: ' + (decoded.join(' | ') || msg.slice(0, 200)));
      } else setError(msg.slice(0, 300));
      setStatus('');
    }
  };

  return (
    <div className="space-y-4">
      {/* Status */}
      {status && (
        <div className="bg-indigo-900/30 border border-indigo-800 rounded-lg p-3 text-indigo-300 text-sm">
          {status}
        </div>
      )}
      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-red-300 text-sm break-all">
          {error}
        </div>
      )}

      {/* SetViewingKey */}
      {!viewingKeySet && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-white font-medium mb-2">Step 1: Register Viewing Key</h3>
          <p className="text-gray-400 text-sm mb-4">
            Required before using the privacy pool. This registers your encrypted viewing key on-chain.
            Note: your account must be at least ~75 minutes old (450 blocks) for proving to work.
          </p>
          <button onClick={handleSetViewingKey} disabled={!!status}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors">
            {status ? 'Processing...' : 'Set Viewing Key'}
          </button>
        </div>
      )}

      {/* Deposit */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-white font-medium mb-2">Deposit STRK</h3>
        <p className="text-gray-400 text-sm mb-3">
          Shield tokens into the privacy pool. Requires viewing key to be set ~70 min prior.
        </p>
        <input type="number" step="0.001" min="0" value={depositAmount}
          onChange={e => setDepositAmount(e.target.value)} placeholder="Amount (STRK)"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-3 focus:border-indigo-500 focus:outline-none" />
        <button onClick={handleDeposit} disabled={!!status || !viewingKeySet}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors">
          {!viewingKeySet ? 'Set viewing key first' : status ? 'Processing...' : 'Deposit'}
        </button>
      </div>

      {/* Withdraw */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-white font-medium mb-2">Withdraw STRK</h3>
        <p className="text-gray-400 text-sm mb-3">Unshield tokens from the privacy pool.</p>
        <input type="text" value={withdrawTo} onChange={e => setWithdrawTo(e.target.value)}
          placeholder="Recipient (0x... or leave empty for self)"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-2 font-mono text-sm focus:border-indigo-500 focus:outline-none" />
        <input type="number" step="0.001" min="0" value={withdrawAmount}
          onChange={e => setWithdrawAmount(e.target.value)} placeholder="Amount (STRK)"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-3 focus:border-indigo-500 focus:outline-none" />
        <button onClick={handleWithdraw} disabled={!!status || !viewingKeySet}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors">
          {!viewingKeySet ? 'Set viewing key first' : status ? 'Processing...' : 'Withdraw'}
        </button>
      </div>

      {/* Private Transfer */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-white font-medium mb-2">Private Transfer</h3>
        <p className="text-gray-400 text-sm mb-3">
          Send STRK privately to another address within the pool. Both sender and recipient remain hidden.
        </p>
        <input type="text" value={transferTo} onChange={e => setTransferTo(e.target.value)}
          placeholder="Recipient Starknet address (0x...)"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-2 font-mono text-sm focus:border-indigo-500 focus:outline-none" />
        <input type="number" step="0.001" min="0" value={transferAmount}
          onChange={e => setTransferAmount(e.target.value)} placeholder="Amount (STRK)"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-3 focus:border-indigo-500 focus:outline-none" />
        <button onClick={handleTransfer} disabled={!!status || !viewingKeySet}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors">
          {!viewingKeySet ? 'Set viewing key first' : status ? 'Processing...' : 'Transfer Privately'}
        </button>
      </div>

      {/* Transaction History */}
      {txs.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-white font-medium mb-3">Transactions</h3>
          <div className="space-y-2">
            {txs.map(tx => (
              <div key={tx.hash} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className={tx.status === 'success' ? 'text-green-400' : tx.status === 'reverted' ? 'text-red-400' : 'text-yellow-400'}>
                    {tx.status === 'success' ? '✓' : tx.status === 'reverted' ? '✗' : '...'}
                  </span>
                  <span className="text-gray-300">{tx.action}</span>
                </div>
                <a href={`${STARKNET_SEPOLIA_EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-indigo-300 hover:text-indigo-200 text-xs">
                  {tx.hash.slice(0, 10)}...
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
