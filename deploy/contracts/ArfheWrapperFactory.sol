// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { ArfheShieldedERC20 } from "./ArfheShieldedERC20.sol";

/**
 * @title ArfheWrapperFactory
 * @notice Deploys and indexes confidential wrappers, so any standard ERC-20 can be
 *         shielded without shipping a new hardcoded address in the wallet.
 *
 * @dev Shielding is per-token: every underlying ERC-20 needs its own {FHERC20ERC20Wrapper}
 *      holding the deposits that back its encrypted balances. Without a factory the wallet
 *      could only ever shield the handful of tokens someone deployed wrappers for by hand.
 *
 *      One wrapper per underlying is enforced. Duplicates would split the backing pool in
 *      two, so balances shielded through one wrapper could not be unshielded through the
 *      other — the registry is what makes "the" wrapper for a token unambiguous.
 *
 *      Creation is permissionless: the wrapper grants no privileges to its deployer, and
 *      gating it would just centralise which tokens can be private.
 *
 *      NOT every ERC-20 is safe to wrap. Rebasing and fee-on-transfer tokens break the
 *      1:1 backing invariant, because the amount that arrives is not the amount credited.
 *      That cannot be detected reliably on-chain, so the wallet warns before creating and
 *      callers must not treat registration as an endorsement.
 */
contract ArfheWrapperFactory {
    /// @dev underlying token => its canonical confidential wrapper.
    mapping(address => address) private _wrappers;

    /// @dev Every wrapper ever created, for enumeration by clients.
    address[] private _allWrappers;

    event WrapperCreated(address indexed underlying, address indexed wrapper, string symbol);

    error WrapperAlreadyExists(address underlying, address wrapper);
    error InvalidUnderlying();

    /**
     * @notice Deploy the confidential wrapper for `underlying`.
     * @dev Name and symbol are derived from the underlying so wallets can label the
     *      wrapper without extra lookups. Tokens with no metadata still work — the symbol
     *      falls back to a generic label rather than reverting.
     * @return wrapper Address of the newly deployed wrapper.
     */
    function createWrapper(IERC20 underlying) external returns (address wrapper) {
        if (address(underlying) == address(0) || address(underlying).code.length == 0) {
            revert InvalidUnderlying();
        }

        address existing = _wrappers[address(underlying)];
        if (existing != address(0)) revert WrapperAlreadyExists(address(underlying), existing);

        string memory symbol = _symbolOf(underlying);

        wrapper = address(
            new ArfheShieldedERC20(
                underlying,
                string.concat("Arfhe Shielded ", symbol),
                string.concat("ae", symbol)
            )
        );

        _wrappers[address(underlying)] = wrapper;
        _allWrappers.push(wrapper);

        emit WrapperCreated(address(underlying), wrapper, symbol);
    }

    /// @notice The confidential wrapper for `underlying`, or `address(0)` if none exists.
    function wrapperFor(address underlying) external view returns (address) {
        return _wrappers[underlying];
    }

    /// @notice Batch lookup, so a wallet can resolve a whole token list in one call.
    function wrappersFor(address[] calldata underlyings) external view returns (address[] memory found) {
        found = new address[](underlyings.length);
        for (uint256 i = 0; i < underlyings.length; i++) {
            found[i] = _wrappers[underlyings[i]];
        }
    }

    /// @notice Total number of wrappers deployed by this factory.
    function wrapperCount() external view returns (uint256) {
        return _allWrappers.length;
    }

    /// @notice Paginated enumeration of every deployed wrapper.
    function wrappersAt(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = _allWrappers.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _allWrappers[i];
        }
    }

    /// @dev Reads `symbol()` defensively — it is optional in ERC-20 and may revert.
    function _symbolOf(IERC20 token) private view returns (string memory) {
        try IERC20Metadata(address(token)).symbol() returns (string memory s) {
            return bytes(s).length == 0 ? "TOKEN" : s;
        } catch {
            return "TOKEN";
        }
    }
}
