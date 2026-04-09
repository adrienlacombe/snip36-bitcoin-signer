import { CallData } from 'starknet';

const calls = [{
  contractAddress: '0x254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91',
  entrypoint: 'apply_actions',
  calldata: ['0x1', '0x2', '0x3'],
}];

const cd = CallData.toCalldata(calls);
console.log('CallData.toCalldata result:', cd);
console.log('length:', cd.length);

// Also try toHex
const cdHex = CallData.toHex(cd);
console.log('CallData.toHex result:', cdHex);
