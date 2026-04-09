use argent::signer::bitcoin::is_valid_bitcoin_signature;
use argent::utils::hashing::poseidon_2;
use core::ecdsa::check_ecdsa_signature;
use starknet::secp256_trait::Signature as Secp256Signature;
use starknet::{EthAddress, eth_signature::is_eth_signature_valid};

/// Magic values used to derive unique GUIDs for each signer type
const STARKNET_SIGNER_TYPE: felt252 = 'Starknet Signer';
const SECP256K1_SIGNER_TYPE: felt252 = 'Secp256k1 Signer';
const BITCOIN_SIGNER_TYPE: felt252 = 'Bitcoin Signer';

pub const SECP_256_K1_HALF: u256 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 / 2;
// from core::ec::stark_curve::ORDER
pub const STARK_CURVE_ORDER_U256: u256 = 0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f;

/// @notice Supported signer types for account authentication
#[derive(Drop, Copy, PartialEq, Serde, Default, starknet::Store, Debug)]
pub enum SignerType {
    #[default]
    Starknet,
    Secp256k1,
    Secp256r1,   // kept for enum index compatibility
    Eip191,      // kept for enum index compatibility
    Webauthn,    // kept for enum index compatibility
    Bitcoin,
}

/// @notice Container for a signature and its associated signer
/// @dev Stripped to Starknet, Secp256k1, and Bitcoin only
#[derive(Drop, Copy, Serde)]
pub enum SignerSignature {
    Starknet: (StarknetSigner, StarknetSignature),
    Secp256k1: (Secp256k1Signer, Secp256Signature),
    Bitcoin: (BitcoinSigner, Secp256Signature),
}

/// @notice The starknet signature using the stark-curve
#[derive(Drop, Copy, Serde)]
pub struct StarknetSignature {
    pub r: felt252,
    pub s: felt252,
}

/// @notice Supported signer types with their data
#[derive(Drop, Copy, Serde, PartialEq)]
pub enum Signer {
    Starknet: StarknetSigner,
    Secp256k1: Secp256k1Signer,
    Bitcoin: BitcoinSigner,
}

/// @notice Storage format for signer data
#[derive(Drop, Copy, Serde, PartialEq, starknet::Store, Default, Debug)]
pub struct SignerStorageValue {
    pub stored_value: felt252,
    pub signer_type: SignerType,
}

/// @notice The Starknet signer using the Starknet Curve
#[derive(Drop, Copy, Serde, PartialEq)]
pub struct StarknetSigner {
    pub pubkey: NonZero<felt252>,
}

/// @notice The Secp256k1 signer using the Secp256k1 elliptic curve
#[derive(Drop, Copy, PartialEq)]
pub struct Secp256k1Signer {
    pub pubkey_hash: EthAddress,
}

/// @notice The Bitcoin signer using secp256k1 with Bitcoin message prefix
/// @param pubkey_hash Poseidon hash of the secp256k1 public key coordinates (x_low, x_high, y_low, y_high)
#[derive(Drop, Copy, PartialEq)]
pub struct BitcoinSigner {
    pub pubkey_hash: felt252,
}

/// @notice Information about a signer stored in the account
#[derive(Drop, Copy, PartialEq, Serde, Debug)]
pub struct SignerInfo {
    signerType: SignerType,
    guid: felt252,
    stored_value: felt252,
}

// Ensures that the pubkey_hash is not zero as we can't do NonZero<EthAddress>
impl Secp256k1SignerSerde of Serde<Secp256k1Signer> {
    fn serialize(self: @Secp256k1Signer, ref output: Array<felt252>) {
        self.pubkey_hash.serialize(ref output);
    }

    fn deserialize(ref serialized: Span<felt252>) -> Option<Secp256k1Signer> {
        let pubkey_hash = Serde::<EthAddress>::deserialize(ref serialized)?;
        assert(pubkey_hash.into() != 0, 'argent/zero-pubkey-hash');
        Option::Some(Secp256k1Signer { pubkey_hash })
    }
}

impl BitcoinSignerSerde of Serde<BitcoinSigner> {
    fn serialize(self: @BitcoinSigner, ref output: Array<felt252>) {
        self.pubkey_hash.serialize(ref output);
    }

    fn deserialize(ref serialized: Span<felt252>) -> Option<BitcoinSigner> {
        let pubkey_hash = Serde::<felt252>::deserialize(ref serialized)?;
        assert(pubkey_hash != 0, 'argent/zero-pubkey-hash');
        Option::Some(BitcoinSigner { pubkey_hash })
    }
}

pub fn starknet_signer_from_pubkey(pubkey: felt252) -> Signer {
    Signer::Starknet(StarknetSigner { pubkey: pubkey.try_into().expect('argent/zero-pubkey') })
}

#[generate_trait]
pub impl SignerTraitImpl of SignerTrait {
    fn into_guid(self: Signer) -> felt252 {
        match self {
            Signer::Starknet(signer) => poseidon_2(STARKNET_SIGNER_TYPE, signer.pubkey.into()),
            Signer::Secp256k1(signer) => poseidon_2(SECP256K1_SIGNER_TYPE, signer.pubkey_hash.into()),
            Signer::Bitcoin(signer) => poseidon_2(BITCOIN_SIGNER_TYPE, signer.pubkey_hash.into()),
        }
    }

    fn storage_value(self: Signer) -> SignerStorageValue {
        match self {
            Signer::Starknet(signer) => SignerStorageValue {
                signer_type: SignerType::Starknet, stored_value: signer.pubkey.into(),
            },
            Signer::Secp256k1(signer) => SignerStorageValue {
                signer_type: SignerType::Secp256k1, stored_value: signer.pubkey_hash.try_into().unwrap(),
            },
            Signer::Bitcoin(signer) => SignerStorageValue {
                signer_type: SignerType::Bitcoin, stored_value: signer.pubkey_hash,
            },
        }
    }

    fn signer_type(self: Signer) -> SignerType {
        match self {
            Signer::Starknet => SignerType::Starknet,
            Signer::Secp256k1 => SignerType::Secp256k1,
            Signer::Bitcoin => SignerType::Bitcoin,
        }
    }

    fn starknet_pubkey_or_none(self: Signer) -> Option<felt252> {
        match self {
            Signer::Starknet(signer) => Option::Some(signer.pubkey.into()),
            _ => Option::None,
        }
    }
}

#[generate_trait]
pub impl SignerStorageValueImpl of SignerStorageTrait {
    fn into_guid(self: SignerStorageValue) -> felt252 {
        match self.signer_type {
            SignerType::Starknet => poseidon_2(STARKNET_SIGNER_TYPE, self.stored_value),
            SignerType::Secp256k1 => poseidon_2(SECP256K1_SIGNER_TYPE, self.stored_value),
            SignerType::Bitcoin => poseidon_2(BITCOIN_SIGNER_TYPE, self.stored_value),
            _ => panic!("unsupported signer type"),
        }
    }

    fn is_stored_as_guid(self: SignerStorageValue) -> bool {
        false
    }

    fn starknet_pubkey_or_none(self: SignerStorageValue) -> Option<felt252> {
        match self.signer_type {
            SignerType::Starknet => Option::Some(self.stored_value),
            _ => Option::None,
        }
    }

    #[must_use]
    fn to_guid_list(self: Span<SignerStorageValue>) -> Array<felt252> {
        let mut guids = array![];
        for signer_storage_value in self {
            guids.append((*signer_storage_value).into_guid());
        };
        guids
    }

    #[must_use]
    fn to_signer_info(self: Span<SignerStorageValue>) -> Array<SignerInfo> {
        let mut signer_info = array![];
        for signer_storage_value in self {
            signer_info.append((*signer_storage_value).into());
        };
        signer_info
    }
}

pub trait SignerSignatureTrait {
    fn is_valid_signature(self: SignerSignature, hash: felt252) -> bool;
    fn signer(self: SignerSignature) -> Signer;
}

impl SignerSignatureImpl of SignerSignatureTrait {
    #[inline(always)]
    fn is_valid_signature(self: SignerSignature, hash: felt252) -> bool {
        match self {
            SignerSignature::Starknet((signer, signature)) => is_valid_starknet_signature(hash, signer, signature),
            SignerSignature::Secp256k1((
                signer, signature,
            )) => is_valid_secp256k1_signature(hash.into(), signer.pubkey_hash.into(), signature),
            SignerSignature::Bitcoin((
                signer, signature,
            )) => is_valid_bitcoin_signature(hash, signer.pubkey_hash, signature),
        }
    }

    #[inline(always)]
    fn signer(self: SignerSignature) -> Signer {
        match self {
            SignerSignature::Starknet((signer, _)) => Signer::Starknet(signer),
            SignerSignature::Secp256k1((signer, _)) => Signer::Secp256k1(signer),
            SignerSignature::Bitcoin((signer, _)) => Signer::Bitcoin(signer),
        }
    }
}

impl SignerTypeIntoFelt252 of Into<SignerType, felt252> {
    fn into(self: SignerType) -> felt252 {
        match self {
            SignerType::Starknet => 0,
            SignerType::Secp256k1 => 1,
            SignerType::Secp256r1 => 2,
            SignerType::Eip191 => 3,
            SignerType::Webauthn => 4,
            SignerType::Bitcoin => 5,
        }
    }
}

impl U256TryIntoSignerType of TryInto<u256, SignerType> {
    fn try_into(self: u256) -> Option<SignerType> {
        if self == 0 { Option::Some(SignerType::Starknet) }
        else if self == 1 { Option::Some(SignerType::Secp256k1) }
        else if self == 2 { Option::Some(SignerType::Secp256r1) }
        else if self == 3 { Option::Some(SignerType::Eip191) }
        else if self == 4 { Option::Some(SignerType::Webauthn) }
        else if self == 5 { Option::Some(SignerType::Bitcoin) }
        else { Option::None }
    }
}

#[inline(always)]
#[must_use]
fn is_valid_starknet_signature(hash: felt252, signer: StarknetSigner, signature: StarknetSignature) -> bool {
    assert(signature.r.into() < STARK_CURVE_ORDER_U256, 'argent/invalid-r-value');
    assert(signature.s.into() < STARK_CURVE_ORDER_U256, 'argent/invalid-s-value');
    check_ecdsa_signature(hash, signer.pubkey.into(), signature.r, signature.s)
}

#[must_use]
pub fn is_valid_secp256k1_signature(hash: u256, pubkey_hash: EthAddress, signature: Secp256Signature) -> bool {
    assert(signature.s <= SECP_256_K1_HALF, 'argent/malleable-signature');
    is_eth_signature_valid(hash, signature, pubkey_hash).is_ok()
}

pub trait SignerSpanTrait {
    #[must_use]
    fn to_guid_list(self: Span<Signer>) -> Array<felt252>;
}

impl SignerSpanTraitImpl of SignerSpanTrait {
    #[must_use]
    fn to_guid_list(self: Span<Signer>) -> Array<felt252> {
        let mut guids = array![];
        for signer in self {
            guids.append((*signer).into_guid());
        };
        guids
    }
}

impl SignerSignatureIntoSignerInfo of Into<SignerStorageValue, SignerInfo> {
    fn into(self: SignerStorageValue) -> SignerInfo {
        SignerInfo { signerType: self.signer_type, guid: self.into_guid(), stored_value: self.stored_value }
    }
}
