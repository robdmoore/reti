import { Contract } from '@algorandfoundation/tealscript';
// import { ValidatorConfig } from "./validatorRegistry.algo";
import { MAX_ALGO_PER_POOL } from './constants.algo';

const MAX_STAKERS_PER_POOL = 80;

type StakedInfo = {
    Account: Address;
    Balance: uint64;
    EntryTime: uint64;
};

// eslint-disable-next-line no-unused-vars
class StakingPool extends Contract {
    programVersion = 9;

    VALIDATOR_REGISTRY_APP_ID = TemplateVar<uint64>();

    // TODO switch to static for size here once supported in tealscript
    Stakers = BoxKey<StaticArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>>({key: 'stakers'});

    ValidatorID = GlobalStateKey<uint64>({key: 'validatorID'})
    PoolID = GlobalStateKey<uint64>({key: 'nodeID'});
    Owner = GlobalStateKey<Address>({key: 'owner'});

    Manager = GlobalStateKey<Address>({key: 'manager'});

    NumStakers = GlobalStateKey<uint64>({key: 'numStakers'});

    TotalAlgoStaked = GlobalStateKey<uint64>({key: 'staked'});

    MaxAlgo = GlobalStateKey<uint64>({key: 'maxStake'});

    /**
     * Initialize the staking pool w/ owner and manager, but can only be created by the validator contract.
     * @param validatorID - id of validator we're a staking pool of
     * @param poolID - which pool id are we
     * @param owner
     * @param manager
     */
    createApplication(validatorID: uint64, poolID: uint64, owner: Address, manager: Address): void {
        // We should be created by the validator contract
        assert(this.txn.sender == Application.fromID(this.VALIDATOR_REGISTRY_APP_ID).address);

        this.ValidatorID.value = validatorID; // Which valida
        this.PoolID.value = poolID;
        this.Owner.value = owner;
        this.Manager.value = manager;
        this.NumStakers.value = 0;
        this.TotalAlgoStaked.value = 0;
        this.MaxAlgo.value = MAX_ALGO_PER_POOL;
        this.Stakers.create();
    }

    /**
     * Adds stake to the given account.
     *
     * @param {Address} account - The account to add stake to.
     * @param {uint64} amountToStake - The amount to stake.
     * @throws {Error} - Throws an error if the staking pool is full.
     * @returns {uint64} timestamp in seconds of stake add.
     */
    addStake(account: Address, amountToStake: uint64): uint64 {
        // account calling us has to be account adding stake
        assert(account !== Account.zeroAddress);
        assert(this.txn.sender === account);

        // Now, is the required amount actually being paid to US (this contract account - the staking pool)
        // Sender doesn't matter - but it 'technically' should be coming from the Validator contract address
        verifyPayTxn(this.txnGroup[this.txn.groupIndex - 1], {
            sender: Application.fromID(this.VALIDATOR_REGISTRY_APP_ID).address,
            receiver: this.app.address,
            amount: amountToStake,
        });
        // See if the account staking is already in our ledger of Stakers - if so, they're just adding to their stake
        // track first empty slot as we go along as well.
        const entryTime = globals.latestTimestamp;
        let firstEmpty = 0;

        // firstEmpty should represent 1-based index to first empty slot we find - 0 means none were found
        // TODO for (let i = 0; i < this.Stakers.value.length; i += 1) {
        for (let i = 0; i < MAX_STAKERS_PER_POOL; i += 1) {
            if (this.Stakers.value[i].Account === account) {
                this.Stakers.value[i].Balance += amountToStake;
                this.Stakers.value[i].EntryTime = entryTime;
                this.TotalAlgoStaked.value += amountToStake;
                return entryTime;
            }
            if (firstEmpty != 0 && this.Stakers.value[i].Account === Address.zeroAddress) {
                firstEmpty = i + 1;
            }
        }
        if (firstEmpty == 0) {
            // nothing was found - pool is full and this staker can't fit
            throw Error('Staking pool full');
        }
        assert(this.Stakers.value[firstEmpty - 1].Account == Address.zeroAddress);
        this.Stakers.value[firstEmpty - 1] = {
            Account: account,
            Balance: amountToStake,
            EntryTime: entryTime,
        };
        this.NumStakers.value += 1;
        this.TotalAlgoStaked.value += amountToStake;
        return entryTime;
    }

    removeStake(account: Address, amountToUnstake: uint64): void {
        // Our we being called by validator ?
        // assert(globals.callerApplicationID.id === this.VALIDATOR_APP_ID);

        // We want to preserve the sanctity that the ONLY account that can call us is the staking account
        // It makes it a bit awkward this way to update the state in the validator but it's safer

        // account calling us has to be account removing stake
        assert(account !== Account.zeroAddress);
        assert(this.txn.sender === account);

        for (let i = 0; i < MAX_STAKERS_PER_POOL; i += 1) {
            if (this.Stakers.value[i].Account === account) {
                if (this.Stakers.value[i].Balance < amountToUnstake) {
                    throw Error('Insufficient balance');
                }
                this.Stakers.value[i].Balance -= amountToUnstake;
                this.TotalAlgoStaked.value -= amountToUnstake;

                // Pay the staker back
                sendPayment({
                    amount: amountToUnstake,
                    receiver: account,
                    note: 'unstaked',
                });
                let stakerRemoved = false;
                if (this.Stakers.value[i].Balance === 0) {
                    // Staker has been 'removed'
                    this.NumStakers.value -= 1;
                    this.Stakers.value[i].Account = Address.zeroAddress;
                    stakerRemoved = true;
                }
                // Call the validator contract and tell it we're removing stake
                // It'll verify we're a valid staking pool id ?
                sendMethodCall<[uint64, uint64, Address, uint64, boolean], void>({
                    applicationID: Application.fromID(this.VALIDATOR_REGISTRY_APP_ID),
                    name: 'stakeRemoved',
                    methodArgs: [this.ValidatorID.value, this.PoolID.value, account, amountToUnstake, stakerRemoved],
                });
                // Now we need to tell the validator contract to remove
                return;
            }
        }
        throw Error('Account not found');
    }

    payStakers(): void {
        assert(this.txn.sender == this.Owner.value || this.txn.sender === this.Manager.value);

        const rewardAvailable = this.app.address.balance - this.TotalAlgoStaked.value - this.app.address.minBalance;
        const payoutConfig = sendMethodCall<[uint64], [uint16, uint32, uint8, uint16]>({
            applicationID: Application.fromID(this.VALIDATOR_REGISTRY_APP_ID),
            name: 'getValidatorConfig',
            methodArgs: [this.ValidatorID.value],
        });
        // first two member of return is:
        //     PayoutEveryXDays: uint16; // Payout frequency - ie: 7, 30, etc.
        //     PercentToValidator: uint32; // Payout percentage expressed w/ two decimals - ie: 500 = 5% -> .05 -
        const payoutDays = payoutConfig[0] as uint64;
        const pctToValidator = payoutConfig[1] as uint64;

        // We're at epoch 'end' presumably - or close enough
        const curTime = globals.latestTimestamp;
        // How many seconds in an epoch..
        const payoutDaysInSecs = payoutDays * 24 * 60 * 60;

        for (let i = 0; i < MAX_STAKERS_PER_POOL; i += 1) {
            if (this.Stakers.value[i].Account !== Address.zeroAddress) {
                // Reward is % of users stake in pool
                // but we deduct based on time in pool
                const timeInPool = curTime - this.Stakers.value[i].EntryTime;
                let timePercentage:uint64;
                // get % of time in pool
                if (timeInPool >= payoutDaysInSecs) {
                    timePercentage = 1000; // == 1.000%
                } else {
                    timePercentage = (timeInPool * 1000) / payoutDaysInSecs;
                }
                const stakerReward = (this.Stakers.value[i].Balance * rewardAvailable) / this.TotalAlgoStaked.value * timePercentage / 1000;
                sendPayment({
                    amount: stakerReward,
                    receiver: this.Stakers.value[i].Account,
                    note: 'staker reward',
                });
            }
        }
    }

    GoOnline(
        votePK: bytes,
        selectionPK: bytes,
        stateProofPK: bytes,
        voteFirst: uint64,
        voteLast: uint64,
        voteKeyDilution: uint64
    ): void {
        assert(this.txn.sender == this.Owner.value || this.txn.sender === this.Manager.value);
        sendOnlineKeyRegistration({
            votePK: votePK,
            selectionPK: selectionPK,
            stateProofPK: stateProofPK,
            voteFirst: voteFirst,
            voteLast: voteLast,
            voteKeyDilution: voteKeyDilution,
        });
    }

    GoOffline(): void {
        assert(this.txn.sender == this.Owner.value || this.txn.sender === this.Manager.value);
        sendOfflineKeyRegistration({});
    }
}
