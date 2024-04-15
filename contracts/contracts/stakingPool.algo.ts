import { Contract } from '@algorandfoundation/tealscript';
// eslint-disable-next-line import/no-cycle
import { PoolTokenPayoutRatio, ValidatorPoolKey, ValidatorRegistry } from './validatorRegistry.algo';
import {
    ALGORAND_ACCOUNT_MIN_BALANCE,
    APPLICATION_BASE_FEE,
    ASSET_HOLDING_FEE,
    MAX_STAKERS_PER_POOL,
    MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL,
    MIN_ALGO_STAKE_PER_POOL,
    SSC_VALUE_BYTES,
    SSC_VALUE_UINT,
} from './constants.algo';

const ALGORAND_STAKING_BLOCK_DELAY = 320; // # of blocks until algorand sees online balance changes in staking
const AVG_BLOCK_TIME_SECS = 28; // in tenths - 28 = 2.8

export type StakedInfo = {
    account: Address;
    balance: uint64;
    totalRewarded: uint64;
    rewardTokenBalance: uint64;
    entryTime: uint64;
};

// eslint-disable-next-line no-unused-vars
/**
 * StakingPool contract has a new instance deployed per staking pool added by any validator.  A single instance
 * is initially immutably deployed, and the id of that instance is used as a construction parameter in the immutable
 * instance of the master ValidatoryRegistry contract.  It then uses that StakingPool instance as a 'factory template'
 * for subsequent pool creations - using the on-chain bytecode of that deployed instance to create a new identical
 * instance.
 *
 * Each instance is explicitly 'linked' to the validator master via its creation parameters.  The validator master
 * contract only allows calls from staking pool contract instances that match data that only the validator master
 * authoritatively has (validator id X, pool Y - has to come from contract address of that pool).  Calls the pools
 * validate coming from the validator are only allowed if it matches the validator id it was created with.
 */
export class StakingPool extends Contract {
    programVersion = 10;

    // When created, we track our creating validator contract so that only this contract can call us.  Independent
    // copies of this contract could be created but only the 'official' validator contract would be considered valid
    // and official.  Calls from these pools back to the validator contract are also validated, ensuring the pool
    // calling the validator is one of the pools it created.
    creatingValidatorContractAppId = GlobalStateKey<uint64>({ key: 'creatorApp' });

    // The 'id' of the validator our pool belongs to
    validatorId = GlobalStateKey<uint64>({ key: 'validatorId' });

    // The pool id we were assigned by the validator contract - sequential id per validator
    poolId = GlobalStateKey<uint64>({ key: 'poolId' });

    // number of stakers in THIS pool
    numStakers = GlobalStateKey<uint64>({ key: 'numStakers' });

    // totalAlgoStaked is total amount staked in THIS pool.
    totalAlgoStaked = GlobalStateKey<uint64>({ key: 'staked' });

    minEntryStake = GlobalStateKey<uint64>({ key: 'minEntryStake' });

    // Last timestamp of a payout - used to ensure payout call isn't cheated and called prior to agreed upon schedule
    lastPayout = GlobalStateKey<uint64>({ key: 'lastPayout' });

    // Epoch number this staking pool is on, with epoch 1 being the 'first' payout
    epochNumber = GlobalStateKey<uint64>({ key: 'epochNumber' });

    // Version of algod this pool is connected to - should be updated regularly
    algodVer = GlobalStateKey<bytes>({ key: 'algodVer' });

    // Our 'ledger' of stakers, tracking each staker account and its balance, total rewards, and last entry time
    stakers = BoxKey<StaticArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>>({ key: 'stakers' });

    nfdRegistryAppId = TemplateVar<uint64>();

    feeSinkAddr = TemplateVar<Address>();

    /**
     * Initialize the staking pool w/ owner and manager, but can only be created by the validator contract.
     * @param {uint64} creatingContractId - id of contract that constructed us - the validator application (single global instance)
     * @param {uint64} validatorId - id of validator we're a staking pool of
     * @param {uint64} poolId - which pool id are we
     * @param {uint64} minEntryStake - minimum amount to be in pool, but also minimum amount balance can't go below (without removing all!)
     */
    createApplication(creatingContractId: uint64, validatorId: uint64, poolId: uint64, minEntryStake: uint64): void {
        if (creatingContractId === 0) {
            // this is likely initial template setup - everything should basically be zero...
            assert(validatorId === 0);
            assert(poolId === 0);
        } else {
            assert(validatorId !== 0);
            assert(poolId !== 0);
        }
        assert(minEntryStake >= MIN_ALGO_STAKE_PER_POOL);
        this.creatingValidatorContractAppId.value = creatingContractId;
        this.validatorId.value = validatorId;
        this.poolId.value = poolId;
        this.numStakers.value = 0;
        this.totalAlgoStaked.value = 0;
        this.minEntryStake.value = minEntryStake;
        this.lastPayout.value = globals.latestTimestamp; // set 'last payout' to init time of pool to establish baseline
        this.epochNumber.value = 0;
    }

    /**
     * gas is a dummy no-op call that can be used to pool-up resource references and opcode cost
     */
    gas(): void {}

    private minBalanceForAccount(
        contracts: uint64,
        extraPages: uint64,
        assets: uint64,
        localInts: uint64,
        localBytes: uint64,
        globalInts: uint64,
        globalBytes: uint64
    ): uint64 {
        let minBal = ALGORAND_ACCOUNT_MIN_BALANCE;
        minBal += contracts * APPLICATION_BASE_FEE;
        minBal += extraPages * APPLICATION_BASE_FEE;
        minBal += assets * ASSET_HOLDING_FEE;
        minBal += localInts * SSC_VALUE_UINT;
        minBal += globalInts * SSC_VALUE_UINT;
        minBal += localBytes * SSC_VALUE_BYTES;
        minBal += globalBytes * SSC_VALUE_BYTES;
        return minBal;
    }

    private costForBoxStorage(totalNumBytes: uint64): uint64 {
        const SCBOX_PERBOX = 2500;
        const SCBOX_PERBYTE = 400;

        return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE;
    }

    /**
     * Called after we're created and then funded so we can create our large stakers ledger storage
     * Caller has to get MBR amounts from ValidatorRegistry to know how much to fund us to cover the box storage cost
     * If this is pool 1 AND the validator has specified a reward token, opt-in to that token
     * so that the validator can seed the pool with future rewards of that token.
     * @param mbrPayment payment from caller which covers mbr increase of new staking pools' storage
     */
    initStorage(mbrPayment: PayTxn): void {
        assert(!this.stakers.exists, 'staking pool already initialized');

        // Get the config of our validator to determine if we issue reward tokens
        const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [this.validatorId.value],
        });
        const isTokenEligible = validatorConfig.rewardTokenId !== 0;
        const extraMBR = isTokenEligible && this.poolId.value === 1 ? ASSET_HOLDING_FEE : 0;
        const PoolInitMbr =
            ALGORAND_ACCOUNT_MIN_BALANCE +
            extraMBR +
            this.costForBoxStorage(7 /* 'stakers' name */ + len<StakedInfo>() * MAX_STAKERS_PER_POOL);

        // the pay transaction must exactly match our MBR requirement.
        verifyPayTxn(mbrPayment, { amount: PoolInitMbr });
        this.stakers.create();

        if (isTokenEligible && this.poolId.value === 1) {
            // opt ourselves in to the reward token if we're pool 1
            sendAssetTransfer({
                xferAsset: AssetID.fromUint64(validatorConfig.rewardTokenId),
                assetReceiver: this.app.address,
                assetAmount: 0,
            });
        }
    }

    /**
     * Adds stake to the given account.
     * Can ONLY be called by the validator contract that created us
     * Must receive payment from the validator contract for amount being staked.
     *
     * @param {PayTxn} stakedAmountPayment prior payment coming from validator contract to us on behalf of staker.
     * @param {Address} staker - The account adding new stake
     * @throws {Error} - Throws an error if the staking pool is full.
     * @returns {uint64} new 'entry time' in seconds of stake add.
     */
    addStake(stakedAmountPayment: PayTxn, staker: Address): uint64 {
        assert(this.stakers.exists);

        // The contract account calling us has to be our creating validator contract
        assert(this.txn.sender === AppID.fromUint64(this.creatingValidatorContractAppId.value).address);
        assert(staker !== globals.zeroAddress);

        // Verify the payment of stake also came from the validator - as it receives the stake from the staker, holds
        // any MBR (if needed) and then sends the stake on to us in the stakedAmountPayment transaction.
        verifyPayTxn(stakedAmountPayment, {
            sender: AppID.fromUint64(this.creatingValidatorContractAppId.value).address,
            receiver: this.app.address,
            amount: stakedAmountPayment.amount,
        });
        // Stake 'maximums' are handled at the validator level - pre-add - so no checks needed here.

        // See if the account staking is already in our ledger of stakers - if so, they're just adding to their stake
        // track first empty slot as we go along as well.
        const entryTime = this.getEntryTime();
        let firstEmpty = 0;

        // firstEmpty should represent 1-based index to first empty slot we find - 0 means none were found
        for (let i = 0; i < this.stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 300) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.stakers.value[i]);
            if (cmpStaker.account === staker) {
                cmpStaker.balance += stakedAmountPayment.amount;
                cmpStaker.entryTime = entryTime;

                // Update the box w/ the new data
                this.stakers.value[i] = cmpStaker;

                this.totalAlgoStaked.value += stakedAmountPayment.amount;
                return entryTime;
            }
            if (cmpStaker.account === globals.zeroAddress) {
                firstEmpty = i + 1;
                break;
            }
        }

        if (firstEmpty === 0) {
            // nothing was found - pool is full and this staker can't fit
            throw Error('Staking pool full');
        }
        // This is a new staker to the pool, so first ensure they're adding required minimum, then
        // initialize slot and add to the stakers.
        // our caller will see stakers increase in state and increase in their state as well.
        assert(stakedAmountPayment.amount >= this.minEntryStake.value, 'must stake at least the minimum for this pool');

        assert(this.stakers.value[firstEmpty - 1].account === globals.zeroAddress);
        this.stakers.value[firstEmpty - 1] = {
            account: staker,
            balance: stakedAmountPayment.amount,
            totalRewarded: 0,
            rewardTokenBalance: 0,
            entryTime: entryTime,
        };
        this.numStakers.value += 1;
        this.totalAlgoStaked.value += stakedAmountPayment.amount;
        return entryTime;
    }

    /**
     * Removes stake on behalf of caller (removing own stake).  If any token rewards exist, those are always sent in
     * full. Also notifies the validator contract for this pools validator of the staker / balance changes.
     *
     * @param {uint64} amountToUnstake - The amount of stake to be removed.  Specify 0 to remove all stake.
     * @throws {Error} If the account has insufficient balance or if the account is not found.
     */
    removeStake(amountToUnstake: uint64): void {
        // We want to preserve the sanctity that the ONLY account that can call us is the staking account
        // It makes it a bit awkward this way to update the state in the validator, but it's safer
        // account calling us has to be account removing stake
        const staker = this.txn.sender;

        for (let i = 0; i < this.stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 300) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.stakers.value[i]);
            if (cmpStaker.account === staker) {
                if (amountToUnstake === 0) {
                    // specifying 0 for unstake amount is requesting to UNSTAKE ALL
                    amountToUnstake = cmpStaker.balance;
                }
                if (cmpStaker.balance < amountToUnstake) {
                    throw Error('Insufficient balance');
                }
                cmpStaker.balance -= amountToUnstake;
                this.totalAlgoStaked.value -= amountToUnstake;

                let amountRewardTokenRemoved = 0;
                if (cmpStaker.rewardTokenBalance > 0) {
                    // If and only if this is pool 1 (where the reward token is held - then we can pay it out)
                    if (this.poolId.value === 1) {
                        const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
                            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
                            methodArgs: [this.validatorId.value],
                        });

                        // ---------
                        // SEND THE REWARD TOKEN NOW - it's in our pool
                        // ---------
                        sendAssetTransfer({
                            xferAsset: AssetID.fromUint64(validatorConfig.rewardTokenId),
                            assetReceiver: staker,
                            assetAmount: cmpStaker.rewardTokenBalance,
                        });
                        amountRewardTokenRemoved = cmpStaker.rewardTokenBalance;
                        cmpStaker.rewardTokenBalance = 0;
                    } else {
                        // If we're in different pool, then we set amountRewardTokenRemoved to amount of reward token to remove
                        // but the stakeRemoved call to the validator will see that a pool other than 1 called it, and
                        // then issues call to pool 1 to do the token payout via 'payTokenReward' method in our contract
                        amountRewardTokenRemoved = cmpStaker.rewardTokenBalance;
                        cmpStaker.rewardTokenBalance = 0;
                    }
                }

                // don't let them reduce their balance below the minEntryStake UNLESS they're removing it all!
                assert(
                    cmpStaker.balance === 0 || cmpStaker.balance >= this.minEntryStake.value,
                    'cannot reduce balance below minimum allowed stake unless all is removed'
                );

                // ---------
                // Pay the staker back
                // ---------
                sendPayment({
                    amount: amountToUnstake,
                    receiver: staker,
                    note: 'unstaked',
                });
                let stakerRemoved = false;
                if (cmpStaker.balance === 0) {
                    // staker has been 'removed' - zero out record
                    this.numStakers.value -= 1;
                    cmpStaker.account = globals.zeroAddress;
                    cmpStaker.totalRewarded = 0;
                    cmpStaker.rewardTokenBalance = 0;
                    stakerRemoved = true;
                }
                // Update the box w/ the new staker data
                this.stakers.value[i] = cmpStaker;

                // Call the validator contract and tell it we're removing stake
                // It'll verify we're a valid staking pool id and update it
                // stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, rewardRemoved: uint64, stakerRemoved: boolean): void
                sendMethodCall<typeof ValidatorRegistry.prototype.stakeRemoved>({
                    applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
                    methodArgs: [
                        { id: this.validatorId.value, poolId: this.poolId.value, poolAppId: this.app.id },
                        staker,
                        amountToUnstake,
                        amountRewardTokenRemoved,
                        stakerRemoved,
                    ],
                });
                return;
            }
        }
        throw Error('account not found');
    }

    /**
     * Claims all the available reward tokens a staker has available, sending their entire balance to the staker from
     * pool 1 (either directly, or via validator->pool1 to pay it out)
     * Also notifies the validator contract for this pools validator of the staker / balance changes.
     */
    claimTokens(): void {
        // We want to preserve the sanctity that the ONLY account that can call us is the staking account
        // It makes it a bit awkward this way to update the state in the validator, but it's safer
        // account calling us has to be account removing stake
        const staker = this.txn.sender;

        for (let i = 0; i < this.stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 300) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.stakers.value[i]);
            if (cmpStaker.account === staker) {
                if (cmpStaker.rewardTokenBalance === 0) {
                    return;
                }
                let amountRewardTokenRemoved = 0;
                // If and only if this is pool 1 (where the reward token is held - then we can pay it out)
                if (this.poolId.value === 1) {
                    const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
                        applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
                        methodArgs: [this.validatorId.value],
                    });
                    // ---------
                    // SEND THE REWARD TOKEN NOW - it's in our pool
                    // ---------
                    sendAssetTransfer({
                        xferAsset: AssetID.fromUint64(validatorConfig.rewardTokenId),
                        assetReceiver: staker,
                        assetAmount: cmpStaker.rewardTokenBalance,
                    });
                    amountRewardTokenRemoved = cmpStaker.rewardTokenBalance;
                    cmpStaker.rewardTokenBalance = 0;
                } else {
                    // If we're in different pool, then we set amountRewardTokenRemoved to amount of reward token to remove
                    // but the stakeRemoved call to the validator will see that a pool other than 1 called it, and
                    // then issues call to pool 1 to do the token payout via 'payTokenReward' method in our contract
                    amountRewardTokenRemoved = cmpStaker.rewardTokenBalance;
                    cmpStaker.rewardTokenBalance = 0;
                }

                // Update the box w/ the new staker balance data (rewardTokenBalance being zeroed)
                this.stakers.value[i] = cmpStaker;

                // Call the validator contract and tell it we're removing stake
                // It'll verify we're a valid staking pool id and update it
                // stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, rewardRemoved: uint64, stakerRemoved: boolean): void
                sendMethodCall<typeof ValidatorRegistry.prototype.stakeRemoved>({
                    applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
                    methodArgs: [
                        { id: this.validatorId.value, poolId: this.poolId.value, poolAppId: this.app.id },
                        staker,
                        0, // no algo removed
                        amountRewardTokenRemoved,
                        false, // staker isn't being removed.
                    ],
                });
                return;
            }
        }
        throw Error('account not found');
    }

    /**
     * Retrieves the staked information for a given staker.
     *
     * @param {Address} staker - The address of the staker.
     * @returns {StakedInfo} - The staked information for the given staker.
     * @throws {Error} - If the staker's account is not found.
     */
    // @abi.readonly
    getStakerInfo(staker: Address): StakedInfo {
        for (let i = 0; i < this.stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 200) {
                increaseOpcodeBudget();
            }
            if (this.stakers.value[i].account === staker) {
                return this.stakers.value[i];
            }
        }
        throw Error('account not found');
    }

    /**
     * [Internal protocol method] Remove a specified amount of 'community token' rewards for a staker.
     * This can ONLY be called by our validator and only if we're pool 1 - with the token.
     * @param staker - the staker account to send rewards to
     * @param rewardToken - id of reward token (to avoid re-entrancy in calling validator back to get id)
     * @param amountToSend - amount to send the staker (there is significant trust here(!) - also why only validator can call us
     */
    payTokenReward(staker: Address, rewardToken: uint64, amountToSend: uint64): void {
        // account calling us has to be our creating validator contract
        assert(this.txn.sender === AppID.fromUint64(this.creatingValidatorContractAppId.value).address);
        assert(this.poolId.value === 1, 'must be pool 1 in order to be called to pay out token rewards');
        assert(rewardToken !== 0, 'can only claim token rewards from validator that has them');

        // Send the reward tokens to the staker
        sendAssetTransfer({
            xferAsset: AssetID.fromUint64(rewardToken),
            assetReceiver: staker,
            assetAmount: amountToSend,
        });
    }

    /**
     * Update the (honor system) algod version for the node associated to this pool.  The node management daemon
     * should compare its current nodes version to the version stored in global state, updating when different.
     * The reti node daemon composes its own version string using format:
     * {major}.{minor}.{build} {branch} [{commit hash}],
     * ie: 3.22.0 rel/stable [6b508975]
     * [ ONLY OWNER OR MANAGER CAN CALL ]
     * @param {string} algodVer - string representing the algorand node daemon version (reti node daemon composes its own meta version)
     */
    updateAlgodVer(algodVer: string): void {
        assert(this.isOwnerOrManagerCaller());
        this.algodVer.value = algodVer;
    }

    /**
     * Updates the balance of stakers in the pool based on the received 'rewards' (current balance vs known staked balance)
     * stakers outstanding balance is adjusted based on their % of stake and time in the current epoch - so that balance
     * compounds over time and staker can remove that amount at will.
     * The validator is paid their percentage each epoch payout.
     *
     * Note: ANYONE can call this.
     */
    epochBalanceUpdate(): void {
        // call the validator contract to get our payout config data
        const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [this.validatorId.value],
        });

        // =====
        // Ensure full Epoch has passed before allowing a new Epoch update to occur
        // =====
        // Since we're being told to payout, we're at epoch 'end' presumably - or close enough
        // but what if we're told to pay really early?  we need to verify that as well.
        const curTime = globals.latestTimestamp;
        // Get configured epoch as seconds since we're block time comparisons will be in seconds
        const epochInSecs = (validatorConfig.payoutEveryXMins as uint64) * 60;
        if (this.lastPayout.exists) {
            const secsSinceLastPayout = curTime - this.lastPayout.value;
            // We've had one payout - so we need to be at least one epoch past the last payout.
            assert(secsSinceLastPayout >= epochInSecs, "Can't payout earlier than last payout + epoch time");
        }
        // Update our payout time - required to match
        this.lastPayout.value = curTime;
        this.epochNumber.value += 1;

        // Determine Token rewards if applicable
        // =====
        // Do we handle token rewards... ?  if so, we need the app address of pool # 1
        const isTokenEligible = validatorConfig.rewardTokenId !== 0;
        let poolOneAppID = this.app.id;
        let poolOneAddress = this.app.address;
        let tokenPayoutRatio: PoolTokenPayoutRatio;

        // Call validator to update our token payout ratio (snapshotting % of whole of all pools so token payout can
        // be divided between pools properly)
        if (isTokenEligible) {
            if (this.poolId.value !== 1) {
                // If we're not pool 1 - figure out its address..
                poolOneAppID = sendMethodCall<typeof ValidatorRegistry.prototype.getPoolAppId>({
                    applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
                    methodArgs: [this.validatorId.value, 1],
                });
                poolOneAddress = AppID.fromUint64(poolOneAppID).address;
            }

            // Snapshot the ratio of token stake per pool across the pools so the token rewards across pools
            // can be based on a stable cross-pool ratio.
            if (this.poolId.value === 1) {
                tokenPayoutRatio = sendMethodCall<typeof ValidatorRegistry.prototype.setTokenPayoutRatio>({
                    applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
                    methodArgs: [this.validatorId.value],
                });
            } else {
                // This isn't pool 2 - so call pool 1 to then ask IT to call the validator to call setTokenPayoutRatio
                tokenPayoutRatio = sendMethodCall<typeof StakingPool.prototype.proxiedSetTokenPayoutRatio>({
                    applicationID: AppID.fromUint64(poolOneAppID),
                    methodArgs: [{ id: this.validatorId.value, poolId: this.poolId.value, poolAppId: this.app.id }],
                });
            }
        }

        // Get the validator state as well - so we know the total staked for the entire validator, and how much token
        // has been held back
        const validatorState = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorState>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [this.validatorId.value],
        });
        const rewardTokenHeldBack = validatorState.rewardTokenHeldBack;

        // Determine ALGO rewards if available
        // =====
        // total reward available is current balance - amount staked (so if 100 was staked but balance is 120 - reward is 20)
        // [not counting MBR which should never be counted - it's not payable]
        let algoRewardAvail = this.app.address.balance - this.totalAlgoStaked.value - this.app.address.minBalance;
        let isPoolSaturated = false;
        const algoSaturationAmt = this.algoSaturationLevel();

        // Now verify if our validator has exceeded the saturation level for the 'protocol' (across all pools) - if so,
        // then we want to:
        // 1) not send the validator any rewards
        // 2) send rewards to the stakers, but diminished - just use ratio of amount over the saturation threshold
        // ie: diminishedReward = (algoRewardAvail * algoSaturationLevel [max per validator]) /  totalAlgoStaked [for validator]
        // 3) The excess is sent to the fee sink.
        if (validatorState.totalAlgoStaked > algoSaturationAmt) {
            isPoolSaturated = true;
        }

        // if tokens are rewarded by this validator and determine how much we have to hand out
        // we'll track amount we actually assign out and let our validator know so it can mark that amount
        // as being held back (for tracking what has been assigned for payout)
        let tokenRewardAvail = 0;
        let tokenRewardPaidOut = 0;
        let validatorCommissionPaidOut = 0;
        let excessToFeeSink = 0;
        if (isTokenEligible) {
            const tokenRewardBal =
                poolOneAddress.assetBalance(AssetID.fromUint64(validatorConfig.rewardTokenId)) - rewardTokenHeldBack;

            // if they have less tokens available then min payout - just ignore and act like no reward is avail
            // leaving tokenRewardAvail as 0
            if (tokenRewardBal >= validatorConfig.rewardPerPayout) {
                // Now - adjust the token rewards to be relative based on this pools stake as % of 'total validator stake'
                // using our prior snapshotted data
                // ignore is because ts thinks tokenPayoutRatio might not be set prior to this call but it has to be,
                // based on isTokenEligible
                // @ts-ignore typescript
                const ourPoolPctOfWhole = tokenPayoutRatio.poolPctOfWhole[this.poolId.value - 1];

                // now adjust the total reward to hand out for this pool based on this pools % of the whole
                tokenRewardAvail = wideRatio([validatorConfig.rewardPerPayout, ourPoolPctOfWhole], [1_000_000]);
            }
        }
        if (tokenRewardAvail === 0) {
            // no token reward - then algo MUST be paid out as we have to do 'something' !
            // Reward available needs to be at lest 1 algo if an algo reward HAS to be paid out (no token reward)
            assert(algoRewardAvail > 1_000_000, 'Reward needs to be at least 1 ALGO');
        }

        if (isPoolSaturated) {
            // see comment where isPoolSaturated is set for changes in rewards...
            // diminishedReward = (reward * maxStakePerPool) / stakeForValidator
            const diminishedReward = wideRatio([algoRewardAvail, algoSaturationAmt], [validatorState.totalAlgoStaked]);
            // send excess to fee sink...
            excessToFeeSink = algoRewardAvail - diminishedReward;
            sendPayment({
                amount: excessToFeeSink,
                receiver: this.getFeeSink(),
                note: 'pool saturated, excess to fee sink',
            });
            // then distribute the smaller reward amount like normal (skipping validator payout entirely)
            algoRewardAvail = diminishedReward;
        } else if (validatorConfig.percentToValidator !== 0) {
            // determine the % that goes to validator...
            // ie: 100[algo] * 50_000 (5% w/4 decimals) / 1_000_000 == 5 [algo]
            validatorCommissionPaidOut = wideRatio(
                [algoRewardAvail, validatorConfig.percentToValidator as uint64],
                [1_000_000]
            );

            // and adjust reward for entire pool accordingly
            algoRewardAvail -= validatorCommissionPaidOut;

            // ---
            // pay the validator their cut !
            // if the manager accounts spendable balance is < 1 ALGO then up to 1 ALGO of the reward will be sent
            // there as well to ensure it stays funded.
            // ---
            if (validatorCommissionPaidOut > 0) {
                // Just to make sure the manager account (which triggers the epochBalanceUpdate calls!) doesn't
                // run out of funds - we'll take up to 1 ALGO off our commission to keep it running.
                let managerTopOff = 0;
                if (
                    validatorConfig.manager !== validatorConfig.validatorCommissionAddress &&
                    validatorConfig.manager.balance - validatorConfig.manager.minBalance < 1_000_000
                ) {
                    managerTopOff = validatorCommissionPaidOut < 1_000_000 ? validatorCommissionPaidOut : 1_000_000;
                    sendPayment({
                        amount: managerTopOff,
                        receiver: validatorConfig.manager,
                        note: 'validator reward to manager for funding epoch updates',
                    });
                }
                if (validatorCommissionPaidOut - managerTopOff > 0) {
                    sendPayment({
                        amount: validatorCommissionPaidOut - managerTopOff,
                        receiver: validatorConfig.validatorCommissionAddress,
                        note: 'validator reward',
                    });
                }
            }
        }

        // We could exit now if (algoRewardAvail === 0 && tokenRewardAvail === 0) which would be the case if validator had
        // commission at 100% for eg, but we still want to inform the validator contract of our payouts
        // so that it can log the appropriate events for indexers, so don't exit early.

        // Now we "pay" (but really just update their tracked balance) the stakers the remainder based on their % of
        // pool and time in this epoch.

        // We'll track the amount of stake we add to stakers based on payouts
        // If any dust is remaining in account it'll be considered part of reward in next epoch.
        let increasedStake = 0;

        /**
         * assume A)lice and B)ob have equal stake... and there is a reward of 100 to divide
         * |------|-------|...
         * A  B
         *        ^ B gets 50% (or 25 of the 50)
         *        at end - we now have 75 'left' - which gets divided across the people at >=100% of epoch time
         *         *        intended result for 100 reward:
         *        if A and B have equal stake... they're each 50% of the 'pool' - call that PP (pool percent)
         *        Time in the epoch - TIE (100% would mean entire epoch - 50% TIE means entered halfway in)
         *        So, we first pay all partials (<100 TIE)
         *        B gets 25....  (100 REWARD * 50 PP (.5) * 50 TIE (.5)) or 25.
         *        -- keep total of stake from each of partial - adding into PartialStake value.
         *        --  we then see that 25 got paid out - so 25 'excess' needs distributed to the 100 TIE stakers on top of their reward.
         *        - reward available is now 75 ALGO to distribute - and PP value is based on percent against new total (TotalStaked-PartialStake)
         *        - so A's PP is now 100% not 50% because their stake is equal to the new reduced stake amount
         *        so A gets 75 (75 REWARD * 100 PP (1) * 100 TIE (1)) or 75
         *        next epoch if nothing else changes - each would get 50% of reward.
         */
        // Iterate all stakers - determine which haven't been for entire epoch - pay them proportionally less for having
        // less time in pool.  We keep track of their stake and then will later reduce the effective 'total staked' amount
        // by that so that the remaining stakers get the remaining reward + excess based on their % of stake against
        // remaining participants.
        let partialStakersTotalStake: uint64 = 0;
        for (let i = 0; i < this.stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 400) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.stakers.value[i]);
            if (cmpStaker.account !== globals.zeroAddress) {
                if (cmpStaker.entryTime > curTime) {
                    // due to 'forward dating' entry time this could be possible
                    // in this case it definitely means they get 0%
                    partialStakersTotalStake += cmpStaker.balance;
                } else {
                    // Reward is % of users stake in pool,
                    // but we deduct based on time away from our payout time
                    const timeInPool = curTime - cmpStaker.entryTime;
                    let timePercentage: uint64;
                    // get % of time in pool (in tenths precision)
                    // ie: 34.7% becomes 347
                    if (timeInPool < epochInSecs) {
                        partialStakersTotalStake += cmpStaker.balance;
                        timePercentage = (timeInPool * 1000) / epochInSecs;

                        if (tokenRewardAvail > 0) {
                            // calc: (balance * avail reward * percent in tenths) / (total staked * 1000)
                            const stakerTokenReward = wideRatio(
                                [cmpStaker.balance, tokenRewardAvail, timePercentage],
                                [this.totalAlgoStaked.value, 1000]
                            );

                            // reduce the reward available (that we're accounting for) so that the subsequent
                            // 'full' pays are based on what's left
                            tokenRewardAvail -= stakerTokenReward;
                            cmpStaker.rewardTokenBalance += stakerTokenReward;
                            tokenRewardPaidOut += stakerTokenReward;
                        }
                        if (algoRewardAvail > 0) {
                            // calc: (balance * avail reward * percent in tenths) / (total staked * 1000)
                            const stakerReward = wideRatio(
                                [cmpStaker.balance, algoRewardAvail, timePercentage],
                                [this.totalAlgoStaked.value, 1000]
                            );

                            // reduce the reward available (that we're accounting for) so that the subsequent
                            // 'full' pays are based on what's left
                            algoRewardAvail -= stakerReward;
                            // instead of sending them algo now - just increase their ledger balance, so they can claim
                            // it at any time.
                            cmpStaker.balance += stakerReward;
                            cmpStaker.totalRewarded += stakerReward;
                            increasedStake += stakerReward;
                        }
                        // Update the box w/ the new data
                        this.stakers.value[i] = cmpStaker;
                    }
                }
            }
        }

        // Reduce the virtual 'total staked in pool' amount based on removing the totals of the stakers we just paid
        // partial amounts.  This is so that all that remains is the stake of the 100% 'time in epoch' people.
        const newPoolTotalStake = this.totalAlgoStaked.value - partialStakersTotalStake;

        // It's technically possible for newPoolTotalStake to be 0, if EVERY staker is new then there'll be nothing to
        // hand out this epoch because we'll have reduced the amount to 'count' towards stake by the entire stake
        if (newPoolTotalStake > 0) {
            // Now go back through the list AGAIN and pay out the full-timers their rewards + excess
            for (let i = 0; i < this.stakers.value.length; i += 1) {
                if (globals.opcodeBudget < 200) {
                    increaseOpcodeBudget();
                }
                const cmpStaker = clone(this.stakers.value[i]);
                if (cmpStaker.account !== globals.zeroAddress && cmpStaker.entryTime < curTime) {
                    const timeInPool = curTime - cmpStaker.entryTime;
                    // We're now only paying out people who've been in pool an entire epoch.
                    if (timeInPool >= epochInSecs) {
                        // we're in for 100%, so it's just % of stakers balance vs 'new total' for their
                        // payment

                        // Handle token payouts first - as we don't want to use existin balance, not post algo-reward balance
                        if (tokenRewardAvail > 0) {
                            const stakerTokenReward = wideRatio(
                                [cmpStaker.balance, tokenRewardAvail],
                                [newPoolTotalStake]
                            );
                            // instead of sending them algo now - just increase their ledger balance, so they can claim
                            // it at any time.
                            cmpStaker.rewardTokenBalance += stakerTokenReward;
                            tokenRewardPaidOut += stakerTokenReward;
                        }
                        if (algoRewardAvail > 0) {
                            const stakerReward = wideRatio([cmpStaker.balance, algoRewardAvail], [newPoolTotalStake]);
                            // instead of sending them algo now - just increase their ledger balance, so they can claim
                            // it at any time.
                            cmpStaker.balance += stakerReward;
                            cmpStaker.totalRewarded += stakerReward;
                            increasedStake += stakerReward;
                        }

                        // Update the box w/ the new data
                        this.stakers.value[i] = cmpStaker;
                    }
                }
            }
        }
        // We've paid out the validator and updated the stakers new balances to reflect the rewards, now update
        // our 'total staked' value as well based on what we paid to validator and updated in staker balances as we
        // determined stake increases
        this.totalAlgoStaked.value += increasedStake;

        // Call the validator contract and tell it we've got new stake added
        // It'll verify we're a valid staking pool id and update the various stats, also logging an event to
        // track the data.
        // stakeUpdatedViaRewards(poolKey,algoToAdd,rewardTokenAmountReserved,validatorCommission,saturatedBurnToFeeSink)
        sendMethodCall<typeof ValidatorRegistry.prototype.stakeUpdatedViaRewards>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [
                { id: this.validatorId.value, poolId: this.poolId.value, poolAppId: this.app.id },
                increasedStake,
                tokenRewardPaidOut,
                validatorCommissionPaidOut,
                excessToFeeSink,
            ],
        });
    }

    /**
     * Registers a staking pool key online against a participation key.
     * [ ONLY OWNER OR MANAGER CAN CALL ]
     *
     * @param {bytes} votePK - The vote public key.
     * @param {bytes} selectionPK - The selection public key.
     * @param {bytes} stateProofPK - The state proof public key.
     * @param {uint64} voteFirst - The first vote index.
     * @param {uint64} voteLast - The last vote index.
     * @param {uint64} voteKeyDilution - The vote key dilution value.
     * @throws {Error} Will throw an error if the caller is not the owner or a manager.
     */
    goOnline(
        votePK: bytes,
        selectionPK: bytes,
        stateProofPK: bytes,
        voteFirst: uint64,
        voteLast: uint64,
        voteKeyDilution: uint64
    ): void {
        assert(this.isOwnerOrManagerCaller());
        sendOnlineKeyRegistration({
            votePK: votePK,
            selectionPK: selectionPK,
            stateProofPK: stateProofPK,
            voteFirst: voteFirst,
            voteLast: voteLast,
            voteKeyDilution: voteKeyDilution,
        });
    }

    /**
     * Marks a staking pool key OFFLINE.
     * [ ONLY OWNER OR MANAGER CAN CALL ]
     *
     */
    goOffline(): void {
        // we can be called by validator contract if we're being moved (which in turn only is allowed to be called
        // by validator owner or manager), but if not - must be owner or manager
        if (this.txn.sender !== AppID.fromUint64(this.creatingValidatorContractAppId.value).address) {
            assert(this.isOwnerOrManagerCaller());
        }

        sendOfflineKeyRegistration({});
    }

    // Links the staking pool's account address to an NFD
    // the contract account address must already be set into the NFD's u.cav.algo.a field pending verification
    // [ ONLY OWNER OR MANAGER CAN CALL ]
    linkToNFD(nfdAppId: uint64, nfdName: string): void {
        assert(this.isOwnerOrManagerCaller());

        sendAppCall({
            applicationID: AppID.fromUint64(this.nfdRegistryAppId),
            applicationArgs: ['verify_nfd_addr', nfdName, itob(nfdAppId), rawBytes(this.app.address)],
            applications: [AppID.fromUint64(nfdAppId)],
        });
    }

    /**
     * proxiedSetTokenPayoutRatio is meant to be called by pools != 1 - calling US, pool #1
     * We need to verify that we are in fact being called by another of OUR pools (not us)
     * and then we'll call the validator on their behalf to update the token payouts
     * @param poolKey - ValidatorPoolKey tuple
     */
    proxiedSetTokenPayoutRatio(poolKey: ValidatorPoolKey): PoolTokenPayoutRatio {
        assert(this.validatorId.value === poolKey.id, 'caller must be part of same validator set!');
        assert(this.poolId.value === 1, 'callee must be pool 1');
        assert(poolKey.poolId !== 1, 'caller must NOT be pool 1');

        const callerPoolAppID = sendMethodCall<typeof ValidatorRegistry.prototype.getPoolAppId>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [poolKey.id, poolKey.poolId],
        });
        assert(callerPoolAppID === poolKey.poolAppId);
        assert(this.txn.sender === AppID.fromUint64(poolKey.poolAppId).address);

        return sendMethodCall<typeof ValidatorRegistry.prototype.setTokenPayoutRatio>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [this.validatorId.value],
        });
    }

    private isOwnerOrManagerCaller(): boolean {
        const OwnerAndManager = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorOwnerAndManager>({
            applicationID: AppID.fromUint64(this.creatingValidatorContractAppId.value),
            methodArgs: [this.validatorId.value],
        });
        return this.txn.sender === OwnerAndManager[0] || this.txn.sender === OwnerAndManager[1];
    }

    /**
     * Calculate the entry time for counting a stake as entering the pool.
     * Algorand won't see the balance increase for ALGORAND_STAKING_BLOCK_DELAY rounds, so we approximate it.
     * The entry time is calculated by adding an approximate number of seconds based on current AVG block times
     * to the original entry time.  This means users don't get payouts based on time their balance wouldn't have
     * been seen by the network.
     *
     * @returns {uint64} - The updated entry time.
     */
    private getEntryTime(): uint64 {
        // entry time is the time we want to count this stake as entering the pool.  Algorand won't see the balance
        // increase for 320 rounds so approximate it as best we can
        const entryTime = globals.latestTimestamp;
        // we add 320 blocks * AVG_BLOCK_TIME_SECS (which is in tenths, where 30 represents 3 seconds)
        // adding that approximate number of seconds to the entry time.
        return entryTime + (ALGORAND_STAKING_BLOCK_DELAY * AVG_BLOCK_TIME_SECS) / 10;
    }

    private getFeeSink(): Address {
        return this.feeSinkAddr;
        // will be like: txn FirstValid; int 1; -; block BlkFeeSink
        // once available in AVM
    }

    /**
     * Returns the maximum allowed stake per validator based on a percentage of all current online stake before
     * the validator is considered saturated - where rewards are diminished.
     */
    private algoSaturationLevel(): uint64 {
        const online = this.getCurrentOnlineStake();

        return wideRatio([online, MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL], [1000]);
    }

    private getCurrentOnlineStake(): uint64 {
        // TODO - replace w/ appropriate AVM call once available but return fixed 2 billion for now.
        return 2_000_000_000_000_000;
    }
}
