// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestERC20
 * @notice Openly mintable ERC-20 for exercising the confidential wrapper flow on testnets.
 *
 * @dev Test infrastructure only — never deployed to a network the wallet treats as real
 *      money. It exists because the confidential path has to be verified against an
 *      arbitrary ERC-20 rather than only the two tokens with hand-deployed wrappers, and
 *      public testnet faucets cannot be driven from a script.
 *
 *      A plain, non-rebasing, non-fee-on-transfer token, which is exactly the class
 *      {ArfheWrapperFactory} is safe to wrap.
 */
contract TestERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Unrestricted by design — anyone can fund themselves for testing.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
