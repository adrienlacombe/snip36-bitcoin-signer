use argent::signer::signer_signature::SECP_256_K1_HALF;
use argent::utils::bytes::eight_words_to_u256;
use core::poseidon::poseidon_hash_span;
use core::sha256::compute_sha256_byte_array;
use starknet::secp256_trait::{
    Secp256PointTrait, Signature as Secp256Signature, is_signature_entry_valid, recover_public_key,
};
use starknet::secp256k1::Secp256k1Point;

/// Validates a Bitcoin-style secp256k1 signature against a Starknet tx hash.
///
/// Uses Poseidon hash of recovered public key coordinates instead of keccak256,
/// making it compatible with the Starknet virtual OS (which lacks keccak support).
///
/// The Ledger Bitcoin app wraps messages with:
///   SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(len) + message))
#[must_use]
pub fn is_valid_bitcoin_signature(
    hash: felt252, pubkey_hash: felt252, signature: Secp256Signature,
) -> bool {
    // Validate r and s are valid secp256k1 scalars (reject out-of-range values)
    assert(is_signature_entry_valid::<Secp256k1Point>(signature.r), 'argent/invalid-r-value');
    assert(is_signature_entry_valid::<Secp256k1Point>(signature.s), 'argent/invalid-s-value');
    // Anti-malleability check
    assert(signature.s <= SECP_256_K1_HALF, 'argent/malleable-signature');

    // Convert felt252 hash to u256
    let hash_u256: u256 = hash.into();

    // Build the 58-byte Bitcoin message:
    //   "\x18Bitcoin Signed Message:\n" (25 bytes) + 0x20 (varint for 32) + tx_hash (32 bytes)
    let mut msg: ByteArray = "";

    // Prefix: \x18Bitcoin Signed Message:\n
    msg.append_byte(0x18);
    msg.append_byte(0x42); // B
    msg.append_byte(0x69); // i
    msg.append_byte(0x74); // t
    msg.append_byte(0x63); // c
    msg.append_byte(0x6f); // o
    msg.append_byte(0x69); // i
    msg.append_byte(0x6e); // n
    msg.append_byte(0x20); // (space)
    msg.append_byte(0x53); // S
    msg.append_byte(0x69); // i
    msg.append_byte(0x67); // g
    msg.append_byte(0x6e); // n
    msg.append_byte(0x65); // e
    msg.append_byte(0x64); // d
    msg.append_byte(0x20); // (space)
    msg.append_byte(0x4d); // M
    msg.append_byte(0x65); // e
    msg.append_byte(0x73); // s
    msg.append_byte(0x73); // s
    msg.append_byte(0x61); // a
    msg.append_byte(0x67); // g
    msg.append_byte(0x65); // e
    msg.append_byte(0x3a); // :
    msg.append_byte(0x0a); // \n

    // Varint for 32 bytes = 0x20
    msg.append_byte(0x20);

    // Append the 32-byte tx hash in big-endian
    append_u128_be(ref msg, hash_u256.high);
    append_u128_be(ref msg, hash_u256.low);

    // First SHA256
    let first_hash = compute_sha256_byte_array(@msg);

    // Second SHA256: hash the 32-byte result of the first hash
    let mut second_input: ByteArray = "";
    append_u32_be(ref second_input, first_hash);
    let double_hash_words = compute_sha256_byte_array(@second_input);

    // Convert [u32; 8] to u256
    let double_hash: u256 = eight_words_to_u256(double_hash_words);

    // Recover public key from the double hash
    let recovered = recover_public_key::<Secp256k1Point>(double_hash, signature);
    if recovered.is_none() {
        return false;
    }

    // Use Poseidon hash of (x, y) coordinates instead of keccak256.
    // This avoids the keccak builtin which is not available in the virtual OS.
    let point = recovered.unwrap();
    let (x, y) = point.get_coordinates().unwrap();
    let recovered_hash = poseidon_hash_span(
        array![x.low.into(), x.high.into(), y.low.into(), y.high.into()].span(),
    );
    recovered_hash == pubkey_hash
}

/// Appends a u128 as 16 big-endian bytes to a ByteArray
fn append_u128_be(ref ba: ByteArray, value: u128) {
    let mut i: u32 = 0;
    loop {
        if i == 16 {
            break;
        }
        // Extract byte at position i (most significant first)
        let shift = 120 - (i * 8);
        let byte: u8 = ((value / pow2_128(shift)) % 256).try_into().unwrap();
        ba.append_byte(byte);
        i += 1;
    };
}

/// Appends [u32; 8] as 32 big-endian bytes to a ByteArray
fn append_u32_be(ref ba: ByteArray, words: [u32; 8]) {
    let [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    append_single_u32_be(ref ba, w0);
    append_single_u32_be(ref ba, w1);
    append_single_u32_be(ref ba, w2);
    append_single_u32_be(ref ba, w3);
    append_single_u32_be(ref ba, w4);
    append_single_u32_be(ref ba, w5);
    append_single_u32_be(ref ba, w6);
    append_single_u32_be(ref ba, w7);
}

/// Appends a single u32 as 4 big-endian bytes
fn append_single_u32_be(ref ba: ByteArray, value: u32) {
    ba.append_byte(((value / 0x1000000) % 0x100).try_into().unwrap());
    ba.append_byte(((value / 0x10000) % 0x100).try_into().unwrap());
    ba.append_byte(((value / 0x100) % 0x100).try_into().unwrap());
    ba.append_byte((value % 0x100).try_into().unwrap());
}

/// Returns 2^n for bit shifts on u128 values
fn pow2_128(n: u32) -> u128 {
    if n == 0 { return 1; }
    if n == 8 { return 0x100; }
    if n == 16 { return 0x10000; }
    if n == 24 { return 0x1000000; }
    if n == 32 { return 0x100000000; }
    if n == 40 { return 0x10000000000; }
    if n == 48 { return 0x1000000000000; }
    if n == 56 { return 0x100000000000000; }
    if n == 64 { return 0x10000000000000000; }
    if n == 72 { return 0x1000000000000000000; }
    if n == 80 { return 0x100000000000000000000; }
    if n == 88 { return 0x10000000000000000000000; }
    if n == 96 { return 0x1000000000000000000000000; }
    if n == 104 { return 0x100000000000000000000000000; }
    if n == 112 { return 0x10000000000000000000000000000; }
    if n == 120 { return 0x1000000000000000000000000000000; }
    panic!("pow2_128: unsupported shift")
}
