// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHERC20 } from "fhenix-confidential-contracts/contracts/FHERC20/FHERC20.sol";
import { FHERC20NativeWrapper } from "fhenix-confidential-contracts/contracts/FHERC20/extensions/FHERC20NativeWrapper.sol";
import { IWETH } from "fhenix-confidential-contracts/contracts/interfaces/IWETH.sol";

/**
 * @title ArfheShieldedETH
 * @notice Confidential ETH for Arfhe Wallet — shields native ETH (or WETH) into an
 *         FHE-encrypted balance and unshields it back through the claim flow.
 *
 * @dev Inherits the audited {FHERC20NativeWrapper}, which supplies the whole surface the
 *      wallet drives:
 *
 *        shieldNative(to)                      native ETH  -> encrypted balance
 *        shieldWrappedNative(to, value)        WETH        -> encrypted balance
 *        confidentialTransfer(to, InEuint64)   private transfer
 *        unshield(from, to, amount)            burn + open a claim
 *        claimUnshielded(id, amount, proof)    settle the claim, release ETH
 *
 *      Confidential precision is capped at 6 decimals (`euint64` overflow guard), so the
 *      wrapper converts at `rate() = 1e12` against 18-decimal ETH. Amounts below one
 *      confidential unit are refunded as dust rather than silently absorbed.
 *
 *      Unshielding is asynchronous by protocol design: `unshield` marks the burned handle
 *      publicly decryptable via `FHE.allowPublic`, the amount is decrypted off-chain with
 *      `decryptForTx`, and `claimUnshielded` verifies that proof before releasing funds.
 */
contract ArfheShieldedETH is FHERC20NativeWrapper {
    /**
     * @param weth_ The canonical WETH contract for the target chain. It backs the pool and
     *              lets the wrapper accept either native ETH or WETH on the way in.
     */
    constructor(IWETH weth_)
        FHERC20("Arfhe Shielded ETH", "aeETH", 6, "")
        FHERC20NativeWrapper(weth_)
    {}

    /**
     * @notice Always zero. The real balance is confidential — see {confidentialBalanceOf}.
     *
     * @dev FHERC20 fills the ERC-20 `balanceOf` with a non-revealing activity counter
     *      (~7984.0000, shifting 0.0001 per transfer) so explorers register the token.
     *      In practice no mainstream tool checks {balanceOfIsIndicator}, so every wallet
     *      and explorer renders that counter as if it were a holding — showing users a
     *      balance of "7983.99 aeETH" they do not have.
     *
     *      Returning zero is the honest answer for a value that is genuinely secret, and
     *      it also removes a real leak: the counter published how many confidential
     *      transfers an address had made.
     *
     *      Safe because the counter is only ever read through this view — the confidential
     *      ledger and the wrapper's backing accounting do not consult it.
     */
    function balanceOf(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Always zero, for the same reason as {balanceOf}.
    function totalSupply() public pure override returns (uint256) {
        return 0;
    }
}
