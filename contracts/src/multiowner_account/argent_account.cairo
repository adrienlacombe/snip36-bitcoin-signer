use argent::multiowner_account::argent_account::ArgentAccount::Event;

pub trait IEmitArgentAccountEvent<TContractState> {
    fn emit_event_callback(ref self: TContractState, event: Event);
}
use argent::signer::signer_signature::SignerSignature;

#[derive(Drop, Copy)]
pub struct AccountSignature {
    pub owner_signature: SignerSignature,
    pub guardian_signature: Option<SignerSignature>,
}

#[starknet::contract(account)]
pub mod ArgentAccount {
    use argent::account::{IAccount, Version};
    use argent::introspection::src5_component;
    use argent::multiowner_account::account_interface::IArgentMultiOwnerAccount;
    use argent::multiowner_account::argent_account::IEmitArgentAccountEvent;
    use argent::multiowner_account::events::{
        AccountCreated, AccountCreatedGuid, SignerLinked, TransactionExecuted,
    };
    use argent::multiowner_account::guardian_manager::{
        IGuardianManager, guardian_manager_component, guardian_manager_component::IGuardianManagerInternal,
    };
    use argent::multiowner_account::owner_manager::{
        owner_manager_component, owner_manager_component::OwnerManagerInternalImpl,
    };
    use argent::signer::signer_signature::{
        Signer, SignerSignature, SignerTrait,
        StarknetSignature, StarknetSigner,
    };
    use argent::upgrade::{
        IUpgradableCallback, upgrade_component, upgrade_component::IUpgradeInternal,
    };
    use argent::utils::{
        asserts::{assert_no_self_call, assert_only_protocol, assert_only_self},
        calls::execute_multicall,
        transaction_version::{
            assert_correct_declare_version, assert_correct_deploy_account_version, assert_correct_invoke_version,
        },
    };
    use openzeppelin_security::reentrancyguard::{ReentrancyGuardComponent, ReentrancyGuardComponent::InternalImpl};
    use starknet::{
        ClassHash, ContractAddress, VALIDATED, account::Call,
        get_execution_info, get_tx_info,
    };
    use super::AccountSignature;

    const NAME: felt252 = 'ArgentAccount';
    const VERSION: Version = Version { major: 0, minor: 5, patch: 0 };

    // Owner management
    component!(path: owner_manager_component, storage: owner_manager, event: OwnerManagerEvents);
    #[abi(embed_v0)]
    impl OwnerManager = owner_manager_component::OwnerManagerImpl<ContractState>;
    // Guardian management
    component!(path: guardian_manager_component, storage: guardian_manager, event: GuardianManagerEvents);
    #[abi(embed_v0)]
    impl GuardianManager = guardian_manager_component::GuardianManagerImpl<ContractState>;
    // Introspection
    component!(path: src5_component, storage: src5, event: SRC5Events);
    #[abi(embed_v0)]
    impl SRC5 = src5_component::SRC5Impl<ContractState>;
    #[abi(embed_v0)]
    impl SRC5Legacy = src5_component::SRC5LegacyImpl<ContractState>;
    // Upgrade
    component!(path: upgrade_component, storage: upgrade, event: UpgradeEvents);
    #[abi(embed_v0)]
    impl Upgradable = upgrade_component::UpgradableImpl<ContractState>;
    // Reentrancy guard
    component!(path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent);

    #[storage]
    struct Storage {
        #[substorage(v0)]
        owner_manager: owner_manager_component::Storage,
        #[substorage(v0)]
        guardian_manager: guardian_manager_component::Storage,
        #[substorage(v0)]
        src5: src5_component::Storage,
        #[substorage(v0)]
        upgrade: upgrade_component::Storage,
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        #[flat]
        OwnerManagerEvents: owner_manager_component::Event,
        #[flat]
        GuardianManagerEvents: guardian_manager_component::Event,
        #[flat]
        SRC5Events: src5_component::Event,
        #[flat]
        UpgradeEvents: upgrade_component::Event,
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        TransactionExecuted: TransactionExecuted,
        AccountCreated: AccountCreated,
        AccountCreatedGuid: AccountCreatedGuid,
        SignerLinked: SignerLinked,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: Signer, guardian: Option<Signer>) {
        let owner_guid = self.owner_manager.initialize(owner);
        let guardian_guid_or_zero = if let Option::Some(guardian) = guardian {
            self.guardian_manager.initialize(guardian)
        } else {
            0
        };

        if let Option::Some(starknet_owner) = owner.starknet_pubkey_or_none() {
            if let Option::Some(guardian) = guardian {
                if let Option::Some(starknet_guardian) = guardian.starknet_pubkey_or_none() {
                    self.emit(AccountCreated { owner: starknet_owner, guardian: starknet_guardian });
                };
            } else {
                self.emit(AccountCreated { owner: starknet_owner, guardian: 0 });
            };
        };
        self.emit(AccountCreatedGuid { owner_guid, guardian_guid: guardian_guid_or_zero });
    }

    #[abi(embed_v0)]
    impl AccountImpl of IAccount<ContractState> {
        fn __validate__(ref self: ContractState, calls: Array<Call>) -> felt252 {
            let exec_info = get_execution_info();
            let tx_info = exec_info.tx_info;
            assert_only_protocol(exec_info.caller_address);
            assert_correct_invoke_version(tx_info.version);
            assert(tx_info.paymaster_data.is_empty(), 'argent/unsupported-paymaster');
            self
                .assert_valid_calls_and_signature(
                    calls: calls.span(),
                    execution_hash: tx_info.transaction_hash,
                    raw_signature: tx_info.signature,
                    account_address: exec_info.contract_address,
                );
            VALIDATED
        }

        fn __execute__(ref self: ContractState, calls: Array<Call>) {
            self.reentrancy_guard.start();
            let exec_info = get_execution_info();
            let tx_info = exec_info.tx_info;
            assert_only_protocol(exec_info.caller_address);
            assert_correct_invoke_version(tx_info.version);

            execute_multicall(calls.span());

            self.emit(TransactionExecuted { hash: tx_info.transaction_hash });
            self.reentrancy_guard.end();
        }

        fn is_valid_signature(self: @ContractState, hash: felt252, signature: Array<felt252>) -> felt252 {
            self.assert_valid_account_signature_raw(hash, signature.span());
            VALIDATED
        }
    }

    // Required Callbacks
    impl EmitArgentAccountEventImpl of IEmitArgentAccountEvent<ContractState> {
        fn emit_event_callback(ref self: ContractState, event: Event) {
            self.emit(event);
        }
    }

    #[abi(embed_v0)]
    impl UpgradeableCallbackImpl of IUpgradableCallback<ContractState> {
        fn perform_upgrade(ref self: ContractState, new_implementation: ClassHash, data: Span<felt252>) {
            assert_only_self();
            self.upgrade.complete_upgrade(new_implementation);
        }
    }

    #[abi(embed_v0)]
    impl ArgentMultiOwnerAccountImpl of IArgentMultiOwnerAccount<ContractState> {
        fn __validate_declare__(self: @ContractState, class_hash: felt252) -> felt252 {
            let tx_info = get_tx_info();
            assert_correct_declare_version(tx_info.version);
            assert(tx_info.paymaster_data.is_empty(), 'argent/unsupported-paymaster');
            self.assert_valid_account_signature_raw(tx_info.transaction_hash, tx_info.signature);
            VALIDATED
        }

        fn __validate_deploy__(
            self: @ContractState,
            class_hash: felt252,
            contract_address_salt: felt252,
            owner: Signer,
            guardian: Option<Signer>,
        ) -> felt252 {
            let tx_info = get_tx_info();
            assert_correct_deploy_account_version(tx_info.version);
            assert(tx_info.paymaster_data.is_empty(), 'argent/unsupported-paymaster');
            self.assert_valid_account_signature_raw(tx_info.transaction_hash, tx_info.signature);
            VALIDATED
        }

        fn change_owners(
            ref self: ContractState,
            owner_guids_to_remove: Array<felt252>,
            owners_to_add: Array<Signer>,
        ) {
            assert_only_self();
            self.owner_manager.change_owners(owner_guids_to_remove, owners_to_add);
        }

        fn change_guardians(
            ref self: ContractState, guardian_guids_to_remove: Array<felt252>, guardians_to_add: Array<Signer>,
        ) {
            assert_only_self();
            self.guardian_manager.change_guardians(:guardian_guids_to_remove, :guardians_to_add);
        }

        fn get_version(self: @ContractState) -> Version {
            VERSION
        }

        fn get_name(self: @ContractState) -> felt252 {
            NAME
        }
    }

    #[generate_trait]
    impl Private of PrivateTrait {
        fn assert_valid_calls_and_signature(
            ref self: ContractState,
            calls: Span<Call>,
            execution_hash: felt252,
            raw_signature: Span<felt252>,
            account_address: ContractAddress,
        ) {
            if calls.len() == 1 {
                let call = calls.at(0);
                if *call.to == account_address {
                    let selector = *call.selector;
                    assert(selector != selector!("perform_upgrade"), 'argent/forbidden-call');
                }
            } else {
                assert_no_self_call(calls, account_address);
            }
            self.assert_valid_account_signature_raw(execution_hash, raw_signature);
        }

        fn parse_account_signature(self: @ContractState, mut raw_signature: Span<felt252>) -> AccountSignature {
            // Check for concise signature format (Starknet signers only)
            if raw_signature.len() != 2 && raw_signature.len() != 4 {
                // Parse regular signature format
                let signature_count = *raw_signature.pop_front().expect('argent/invalid-signature-format');
                if signature_count == 1 {
                    let owner_signature: SignerSignature = Serde::deserialize(ref raw_signature)
                        .expect('argent/invalid-signature-format');
                    assert(raw_signature.is_empty(), 'argent/invalid-signature-length');
                    return AccountSignature { owner_signature, guardian_signature: Option::None };
                } else if signature_count == 2 {
                    let owner_signature: SignerSignature = Serde::deserialize(ref raw_signature)
                        .expect('argent/invalid-signature-format');
                    let guardian_signature: SignerSignature = Serde::deserialize(ref raw_signature)
                        .expect('argent/invalid-signature-format');
                    assert(raw_signature.is_empty(), 'argent/invalid-signature-length');
                    return AccountSignature { owner_signature, guardian_signature: Option::Some(guardian_signature) };
                } else {
                    core::panic_with_felt252('argent/invalid-signature-length');
                };
            };

            let single_stark_owner = self
                .owner_manager
                .get_single_stark_owner_pubkey()
                .expect('argent/no-single-stark-owner');
            let owner_signature = SignerSignature::Starknet(
                (
                    StarknetSigner { pubkey: single_stark_owner.try_into().expect('argent/zero-pubkey') },
                    StarknetSignature {
                        r: *raw_signature.pop_front().unwrap(), s: *raw_signature.pop_front().unwrap(),
                    },
                ),
            );
            if raw_signature.is_empty() {
                return AccountSignature { owner_signature, guardian_signature: Option::None };
            }

            let single_stark_guardian = self.guardian_manager.get_single_stark_guardian_pubkey();

            let guardian_signature = SignerSignature::Starknet(
                (
                    StarknetSigner { pubkey: single_stark_guardian.try_into().expect('argent/zero-pubkey') },
                    StarknetSignature {
                        r: *raw_signature.pop_front().unwrap(), s: *raw_signature.pop_front().unwrap(),
                    },
                ),
            );
            return AccountSignature { owner_signature, guardian_signature: Option::Some(guardian_signature) };
        }

        #[inline(always)]
        fn assert_valid_account_signature_raw(self: @ContractState, hash: felt252, raw_signature: Span<felt252>) {
            self.assert_valid_account_signature(hash, self.parse_account_signature(raw_signature));
        }

        #[inline(always)]
        fn assert_valid_account_signature(self: @ContractState, hash: felt252, account_signature: AccountSignature) {
            assert(self.is_valid_owner_signature(hash, account_signature.owner_signature), 'argent/invalid-owner-sig');
            if let Option::Some(guardian_signature) = account_signature.guardian_signature {
                assert(self.is_valid_guardian_signature(hash, guardian_signature), 'argent/invalid-guardian-sig');
            } else {
                assert(!self.guardian_manager.has_guardian(), 'argent/missing-guardian-sig');
            };
        }
    }
}
