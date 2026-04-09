use argent::account::Version;
use argent::signer::signer_signature::Signer;

#[starknet::interface]
pub trait IArgentMultiOwnerAccount<TContractState> {
    fn __validate_declare__(self: @TContractState, class_hash: felt252) -> felt252;
    fn __validate_deploy__(
        self: @TContractState,
        class_hash: felt252,
        contract_address_salt: felt252,
        owner: Signer,
        guardian: Option<Signer>,
    ) -> felt252;

    fn change_owners(
        ref self: TContractState,
        owner_guids_to_remove: Array<felt252>,
        owners_to_add: Array<Signer>,
    );

    fn change_guardians(
        ref self: TContractState, guardian_guids_to_remove: Array<felt252>, guardians_to_add: Array<Signer>,
    );

    fn get_name(self: @TContractState) -> felt252;
    fn get_version(self: @TContractState) -> Version;
}
