// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { FHERC20 } from "fhenix-confidential-contracts/contracts/FHERC20/FHERC20.sol";
import { FHERC20ERC20Wrapper } from "fhenix-confidential-contracts/contracts/FHERC20/extensions/FHERC20ERC20Wrapper.sol";

/**
 * @title ArfheShieldedERC20
 * @notice Confidential wrapper around an existing ERC-20 (USDC on the Arfhe testnets).
 *
 * @dev Inherits the audited {FHERC20ERC20Wrapper}:
 *
 *        shield(to, amount)                    ERC-20 -> encrypted balance (needs approve)
 *        confidentialTransfer(to, InEuint64)   private transfer
 *        unshield(from, to, amount)            burn + open a claim
 *        claimUnshielded(id, amount, proof)    settle the claim, release the ERC-20
 *
 *      Name and symbol are constructor arguments so one implementation serves every
 *      underlying token; `decimals()` is overridden by the wrapper to the confidential
 *      precision (min(underlying decimals, 6)), and `rate()` reports the conversion factor.
 *
 *      Only plain ERC-20s are safe here — rebasing and fee-on-transfer tokens break the
 *      1:1 backing invariant and must not be wrapped.
 */
contract ArfheShieldedERC20 is FHERC20ERC20Wrapper {
    /**
     * @param underlying_ The ERC-20 being shielded.
     * @param name_       Display name for the confidential token.
     * @param symbol_     Display symbol for the confidential token.
     */
    constructor(IERC20 underlying_, string memory name_, string memory symbol_)
        FHERC20(name_, symbol_, 6, "")
        FHERC20ERC20Wrapper(underlying_)
    {}

    /**
     * @notice Always zero. The real balance is confidential — see {confidentialBalanceOf}.
     *
     * @dev FHERC20 fills the ERC-20 `balanceOf` with a non-revealing activity counter
     *      (~7984.0000, shifting 0.0001 per transfer) so explorers register the token.
     *      In practice no mainstream tool checks {balanceOfIsIndicator}, so every wallet
     *      and explorer renders that counter as if it were a holding — showing users a
     *      balance they do not have.
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
